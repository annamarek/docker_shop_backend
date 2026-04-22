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
const mssql_1 = __importDefault(require("mssql"));
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
let channel = null;
let dbPool = null;
const messages = {
    en: {
        health: "Auth service is running",
        emailTaken: "Email is already registered",
        adminRegisterForbidden: "Admin registration is disabled",
        invalidCredentials: "Invalid credentials",
        registered: "User registered successfully",
        loggedIn: "Login successful"
    },
    uk: {
        health: "Сервіс авторизації працює",
        emailTaken: "Email вже зареєстрований",
        adminRegisterForbidden: "Реєстрація адміністратора заборонена",
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
    if (!dbPool) {
        return res.status(503).json({ message: "Database is not ready" });
    }
    const existing = await dbPool.request().input("email", mssql_1.default.NVarChar, email).query("SELECT TOP 1 id, name, email, passwordHash, role FROM users WHERE email = @email");
    if (existing.recordset.length > 0) {
        return res.status(409).json({ message: t(lang, "emailTaken") });
    }
    if (role === "Admin") {
        return res.status(403).json({ message: t(lang, "adminRegisterForbidden") });
    }
    const passwordHash = await bcryptjs_1.default.hash(password, 10);
    const userRole = "Customer";
    const inserted = await dbPool
        .request()
        .input("name", mssql_1.default.NVarChar, name)
        .input("email", mssql_1.default.NVarChar, email)
        .input("passwordHash", mssql_1.default.NVarChar, passwordHash)
        .input("role", mssql_1.default.NVarChar, userRole)
        .query("INSERT INTO users (name, email, passwordHash, role) OUTPUT INSERTED.id, INSERTED.name, INSERTED.email, INSERTED.passwordHash, INSERTED.role VALUES (@name, @email, @passwordHash, @role)");
    const user = inserted.recordset[0];
    publish("user.registered", { id: user.id, name: user.name, email: user.email, role: user.role });
    return res.status(201).json({
        message: t(lang, "registered"),
        user: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
});
app.post("/login", async (req, res) => {
    const lang = detectLang(req.header("accept-language"));
    const { email, password } = req.body;
    if (!dbPool) {
        return res.status(503).json({ message: "Database is not ready" });
    }
    const result = await dbPool.request().input("email", mssql_1.default.NVarChar, email).query("SELECT TOP 1 id, name, email, passwordHash, role FROM users WHERE email = @email");
    const user = result.recordset[0];
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
const connectDb = async () => {
    const host = process.env.DB_HOST || "sqlserver";
    const dbPort = Number(process.env.DB_PORT || 1433);
    const user = process.env.DB_USER || "sa";
    const password = process.env.DB_PASSWORD || "StrongPass123!";
    const dbName = process.env.DB_NAME || "docker_shop";
    const baseConfig = {
        user,
        password,
        server: host,
        port: dbPort,
        options: {
            encrypt: false,
            trustServerCertificate: true
        }
    };
    const masterPool = await mssql_1.default.connect({ ...baseConfig, database: "master" });
    await masterPool
        .request()
        .input("dbName", mssql_1.default.NVarChar, dbName)
        .query("IF DB_ID(@dbName) IS NULL EXEC('CREATE DATABASE [' + @dbName + ']')");
    await masterPool.close();
    dbPool = await mssql_1.default.connect({ ...baseConfig, database: dbName });
    await dbPool.query(`
    IF OBJECT_ID('users', 'U') IS NULL
    BEGIN
      CREATE TABLE users (
        id INT IDENTITY(1,1) PRIMARY KEY,
        name NVARCHAR(255) NOT NULL,
        email NVARCHAR(255) NOT NULL UNIQUE,
        passwordHash NVARCHAR(255) NOT NULL,
        role NVARCHAR(50) NOT NULL
      );
    END
  `);
    // Ensure exactly one system admin account exists and is managed by configuration.
    const adminName = process.env.ADMIN_NAME || "Admin";
    const adminEmail = process.env.ADMIN_EMAIL || "admin@test.com";
    const adminPassword = process.env.ADMIN_PASSWORD || "123456";
    const existingAdmin = await dbPool
        .request()
        .input("email", mssql_1.default.NVarChar, adminEmail)
        .query("SELECT TOP 1 id, name, email, passwordHash, role FROM users WHERE email = @email");
    if (existingAdmin.recordset.length === 0) {
        const adminHash = await bcryptjs_1.default.hash(adminPassword, 10);
        await dbPool
            .request()
            .input("name", mssql_1.default.NVarChar, adminName)
            .input("email", mssql_1.default.NVarChar, adminEmail)
            .input("passwordHash", mssql_1.default.NVarChar, adminHash)
            .input("role", mssql_1.default.NVarChar, "Admin")
            .query("INSERT INTO users (name, email, passwordHash, role) VALUES (@name, @email, @passwordHash, @role)");
    }
};
Promise.all([connectRabbit(), connectDb()])
    .catch((error) => {
    console.error("Bootstrap error in auth-service:", error);
})
    .finally(() => {
    app.listen(port, () => {
        console.log(`auth-service listening on port ${port}`);
    });
});
