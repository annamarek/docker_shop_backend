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
const port = Number(process.env.PORT || 4002);
const jwtSecret = process.env.JWT_SECRET || "secret";
const rabbitUrl = process.env.RABBITMQ_URL || "amqp://rabbitmq:5672";
const exchange = process.env.RABBITMQ_EXCHANGE || "shop.events";
const users = new Map();
const messages = {
    en: {
        health: "User service is running",
        unauthorized: "Unauthorized",
        forbidden: "Forbidden",
        notFound: "User not found"
    },
    uk: {
        health: "Сервіс користувачів працює",
        unauthorized: "Неавторизовано",
        forbidden: "Доступ заборонено",
        notFound: "Користувача не знайдено"
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
app.get("/health", (req, res) => {
    const lang = detectLang(req.header("accept-language"));
    res.json({ message: t(lang, "health") });
});
app.get("/me", auth, (req, res) => {
    const lang = detectLang(req.header("accept-language"));
    const user = users.get(Number(req.user?.sub));
    if (!user) {
        return res.status(404).json({ message: t(lang, "notFound") });
    }
    return res.json({ user });
});
app.get("/users/:id", auth, (req, res) => {
    const lang = detectLang(req.header("accept-language"));
    const role = req.user?.role;
    const requesterId = Number(req.user?.sub);
    const targetId = Number(req.params.id);
    if (role !== "Admin" && requesterId !== targetId) {
        return res.status(403).json({ message: t(lang, "forbidden") });
    }
    const user = users.get(targetId);
    if (!user) {
        return res.status(404).json({ message: t(lang, "notFound") });
    }
    return res.json({ user });
});
const bootstrap = async () => {
    const connection = await amqplib_1.default.connect(rabbitUrl);
    const channel = await connection.createChannel();
    await channel.assertExchange(exchange, "topic", { durable: false });
    const queue = await channel.assertQueue("", { exclusive: true });
    await channel.bindQueue(queue.queue, exchange, "user.registered");
    channel.consume(queue.queue, (msg) => {
        if (!msg)
            return;
        const payload = JSON.parse(msg.content.toString());
        users.set(payload.id, payload);
    });
};
bootstrap()
    .catch((error) => {
    console.error("user-service rabbit init failed:", error);
})
    .finally(() => {
    app.listen(port, () => {
        console.log(`user-service listening on port ${port}`);
    });
});
