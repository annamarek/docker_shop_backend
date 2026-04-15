"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const amqplib_1 = __importDefault(require("amqplib"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
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
const port = Number(process.env.PORT || 4001);
const jwtSecret = process.env.JWT_SECRET || "secret";
const rabbitUrl = process.env.RABBITMQ_URL || "amqp://rabbitmq:5672";
const exchange = process.env.RABBITMQ_EXCHANGE || "shop.events";
const users = [];
let nextId = 1;
let channel = null;
const messages = {
    en: {
        health: "Auth service is running",
        emailTaken: "Email is already registered",
        invalidCredentials: "Invalid credentials",
        registered: "User registered successfully",
        loggedIn: "Login successful"
    },
    uk: {
        health: "Сервіс авторизації працює",
        emailTaken: "Email вже зареєстрований",
        invalidCredentials: "Невірні облікові дані",
        registered: "Користувача успішно зареєстровано",
        loggedIn: "Вхід успішний"
    }
};
const detectLang = (header) => header?.toLowerCase().startsWith("uk") ? "uk" : "en";
const t = (lang, key) => messages[lang][key] ?? key;
const connectRabbit = async () => {
    const connection = await amqplib_1.default.connect(rabbitUrl);
    channel = await connection.createChannel();
    await channel.assertExchange(exchange, "topic", { durable: false });
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
app.post("/register", async (req, res) => {
    const lang = detectLang(req.header("accept-language"));
    const { name, email, password, role } = req.body;
    if (users.some((u) => u.email === email)) {
        return res.status(409).json({ message: t(lang, "emailTaken") });
    }
    const passwordHash = await bcryptjs_1.default.hash(password, 10);
    const userRole = role === "Admin" ? "Admin" : "Customer";
    const user = { id: nextId++, name, email, passwordHash, role: userRole };
    users.push(user);
    publish("user.registered", { id: user.id, name: user.name, email: user.email, role: user.role });
    return res.status(201).json({
        message: t(lang, "registered"),
        user: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
});
app.post("/login", async (req, res) => {
    const lang = detectLang(req.header("accept-language"));
    const { email, password } = req.body;
    const user = users.find((u) => u.email === email);
    if (!user) {
        return res.status(401).json({ message: t(lang, "invalidCredentials") });
    }
    const isValid = await bcryptjs_1.default.compare(password, user.passwordHash);
    if (!isValid) {
        return res.status(401).json({ message: t(lang, "invalidCredentials") });
    }
    const token = jsonwebtoken_1.default.sign({ sub: user.id, email: user.email, role: user.role, name: user.name }, jwtSecret, { expiresIn: "12h" });
    return res.json({ message: t(lang, "loggedIn"), token });
});
connectRabbit()
    .catch((error) => {
    console.error("RabbitMQ connection error in auth-service:", error);
})
    .finally(() => {
    app.listen(port, () => {
        console.log(`auth-service listening on port ${port}`);
    });
});
