"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const amqplib_1 = __importDefault(require("amqplib"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const express_1 = __importDefault(require("express"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const morgan_1 = __importDefault(require("morgan"));
dotenv_1.default.config();
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use((0, morgan_1.default)("dev"));
const port = Number(process.env.PORT || 4004);
const jwtSecret = process.env.JWT_SECRET || "secret";
const rabbitUrl = process.env.RABBITMQ_URL || "amqp://rabbitmq:5672";
const exchange = process.env.RABBITMQ_EXCHANGE || "shop.events";
const orders = [];
let nextId = 1;
let channel = null;
const messages = {
    en: {
        health: "Order service is running",
        unauthorized: "Unauthorized",
        forbidden: "Forbidden",
        notFound: "Order not found"
    },
    uk: {
        health: "Сервіс замовлень працює",
        unauthorized: "Неавторизовано",
        forbidden: "Доступ заборонено",
        notFound: "Замовлення не знайдено"
    }
};
const detectLang = (header) => header?.toLowerCase().startsWith("uk") ? "uk" : "en";
const t = (lang, key) => messages[lang][key] ?? key;
const auth = (req, res, next) => {
    const lang = detectLang(req.header("accept-language"));
    const token = req.header("authorization")?.replace("Bearer ", "");
    if (!token) {
        res.status(401).json({ message: t(lang, "unauthorized") });
        return;
    }
    try {
        req.user = jsonwebtoken_1.default.verify(token, jwtSecret);
        next();
    }
    catch {
        res.status(401).json({ message: t(lang, "unauthorized") });
    }
};
const publish = (routingKey, payload) => {
    if (!channel)
        return;
    channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(payload)));
};
app.get("/health", (req, res) => {
    const lang = detectLang(req.header("accept-language"));
    res.json({ message: t(lang, "health") });
});
app.post("/orders", auth, (req, res) => {
    const userId = Number(req.user?.sub);
    const items = req.body.items;
    const order = { id: nextId++, userId, items, status: "Pending" };
    orders.push(order);
    publish("order.created", order);
    return res.status(201).json({ order });
});
app.get("/orders", auth, (req, res) => {
    const role = req.user?.role;
    const userId = Number(req.user?.sub);
    if (role === "Admin") {
        return res.json({ orders });
    }
    return res.json({ orders: orders.filter((o) => o.userId === userId) });
});
app.patch("/orders/:id/status", auth, (req, res) => {
    const lang = detectLang(req.header("accept-language"));
    if (req.user?.role !== "Admin") {
        return res.status(403).json({ message: t(lang, "forbidden") });
    }
    const id = Number(req.params.id);
    const status = req.body.status;
    const order = orders.find((o) => o.id === id);
    if (!order) {
        return res.status(404).json({ message: t(lang, "notFound") });
    }
    order.status = status;
    if (status === "Paid") {
        publish("order.paid", order);
    }
    return res.json({ order });
});
const bootstrap = async () => {
    const connection = await amqplib_1.default.connect(rabbitUrl);
    channel = await connection.createChannel();
    await channel.assertExchange(exchange, "topic", { durable: false });
};
bootstrap()
    .catch((error) => {
    console.error("order-service rabbit init failed:", error);
})
    .finally(() => {
    app.listen(port, () => {
        console.log(`order-service listening on port ${port}`);
    });
});
