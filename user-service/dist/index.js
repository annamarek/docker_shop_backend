"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
const port = Number(process.env.PORT || 4002);
const jwtSecret = process.env.JWT_SECRET || "secret";
let dbPool = null;
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
    if (!dbPool) {
        return res.status(503).json({ message: "Database is not ready" });
    }
    const userId = Number(req.user?.sub);
    dbPool
        .request()
        .input("id", mssql_1.default.Int, userId)
        .query("SELECT id, name, email, role FROM users WHERE id = @id")
        .then((result) => {
        const user = result.recordset[0];
        if (!user) {
            return res.status(404).json({ message: t(lang, "notFound") });
        }
        return res.json({ user });
    })
        .catch((error) => {
        console.error("user-service /me error:", error);
        return res.status(500).json({ message: "Internal server error" });
    });
});
app.get("/users/:id", auth, (req, res) => {
    const lang = detectLang(req.header("accept-language"));
    const role = req.user?.role;
    const requesterId = Number(req.user?.sub);
    const targetId = Number(req.params.id);
    if (role !== "Admin" && requesterId !== targetId) {
        return res.status(403).json({ message: t(lang, "forbidden") });
    }
    if (!dbPool) {
        return res.status(503).json({ message: "Database is not ready" });
    }
    dbPool
        .request()
        .input("id", mssql_1.default.Int, targetId)
        .query("SELECT id, name, email, role FROM users WHERE id = @id")
        .then((result) => {
        const user = result.recordset[0];
        if (!user) {
            return res.status(404).json({ message: t(lang, "notFound") });
        }
        return res.json({ user });
    })
        .catch((error) => {
        console.error("user-service /users/:id error:", error);
        return res.status(500).json({ message: "Internal server error" });
    });
});
app.get("/users", auth, async (req, res) => {
    const lang = detectLang(req.header("accept-language"));
    if (req.user?.role !== "Admin") {
        return res.status(403).json({ message: t(lang, "forbidden") });
    }
    if (!dbPool) {
        return res.status(503).json({ message: "Database is not ready" });
    }
    const result = await dbPool.query("SELECT id, name, email, role FROM users ORDER BY id");
    return res.json({ users: result.recordset });
});
app.patch("/users/:id/role", auth, async (req, res) => {
    const lang = detectLang(req.header("accept-language"));
    if (req.user?.role !== "Admin") {
        return res.status(403).json({ message: t(lang, "forbidden") });
    }
    if (!dbPool) {
        return res.status(503).json({ message: "Database is not ready" });
    }
    const id = Number(req.params.id);
    const role = String(req.body.role || "");
    if (role !== "Admin" && role !== "Customer") {
        return res.status(400).json({ message: "Invalid role" });
    }
    const result = await dbPool
        .request()
        .input("id", mssql_1.default.Int, id)
        .input("role", mssql_1.default.NVarChar, role)
        .query("UPDATE users SET role = @role OUTPUT INSERTED.id, INSERTED.name, INSERTED.email, INSERTED.role WHERE id = @id");
    const user = result.recordset[0];
    if (!user) {
        return res.status(404).json({ message: t(lang, "notFound") });
    }
    return res.json({ user });
});
const bootstrap = async () => {
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
        options: { encrypt: false, trustServerCertificate: true }
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
};
bootstrap()
    .catch((error) => {
    console.error("user-service bootstrap init failed:", error);
})
    .finally(() => {
    app.listen(port, () => {
        console.log(`user-service listening on port ${port}`);
    });
});
