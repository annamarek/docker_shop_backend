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
const mssql_1 = __importDefault(require("mssql"));
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
let channel = null;
let dbPool = null;
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
app.post("/orders", auth, async (req, res) => {
    const userId = Number(req.user?.sub);
    const items = req.body.items;
    if (!dbPool) {
        return res.status(503).json({ message: "Database is not ready" });
    }
    const insertOrder = await dbPool
        .request()
        .input("userId", mssql_1.default.Int, userId)
        .input("status", mssql_1.default.NVarChar, "Pending")
        .query("INSERT INTO orders (userId, status) OUTPUT INSERTED.id VALUES (@userId, @status)");
    const orderId = insertOrder.recordset[0].id;
    for (const item of items) {
        await dbPool
            .request()
            .input("orderId", mssql_1.default.Int, orderId)
            .input("productId", mssql_1.default.Int, item.productId)
            .input("quantity", mssql_1.default.Int, item.quantity)
            .query("INSERT INTO order_items (orderId, productId, quantity) VALUES (@orderId, @productId, @quantity)");
    }
    const order = { id: orderId, userId, items, status: "Pending" };
    publish("order.created", order);
    return res.status(201).json({ order });
});
app.get("/orders", auth, async (req, res) => {
    if (!dbPool) {
        return res.status(503).json({ message: "Database is not ready" });
    }
    const role = req.user?.role;
    const userId = Number(req.user?.sub);
    const query = role === "Admin"
        ? "SELECT id, userId, status FROM orders ORDER BY id DESC"
        : "SELECT id, userId, status FROM orders WHERE userId = @userId ORDER BY id DESC";
    const ordersResult = role === "Admin"
        ? await dbPool.request().query(query)
        : await dbPool
            .request()
            .input("userId", mssql_1.default.Int, userId)
            .query(query);
    const orderRows = ordersResult.recordset;
    if (orderRows.length === 0) {
        return res.json({ orders: [] });
    }
    const idsCsv = orderRows.map((o) => o.id).join(",");
    const itemsResult = await dbPool.query(`SELECT orderId, productId, quantity FROM order_items WHERE orderId IN (${idsCsv})`);
    const itemsByOrder = new Map();
    for (const row of itemsResult.recordset) {
        const existing = itemsByOrder.get(row.orderId) || [];
        existing.push({ productId: row.productId, quantity: row.quantity });
        itemsByOrder.set(row.orderId, existing);
    }
    const orders = orderRows.map((row) => ({
        id: row.id,
        userId: row.userId,
        status: row.status,
        items: itemsByOrder.get(row.id) || []
    }));
    return res.json({ orders });
});
app.patch("/orders/:id/status", auth, async (req, res) => {
    const lang = detectLang(req.header("accept-language"));
    if (req.user?.role !== "Admin") {
        return res.status(403).json({ message: t(lang, "forbidden") });
    }
    if (!dbPool) {
        return res.status(503).json({ message: "Database is not ready" });
    }
    const id = Number(req.params.id);
    const status = req.body.status;
    const updated = await dbPool
        .request()
        .input("id", mssql_1.default.Int, id)
        .input("status", mssql_1.default.NVarChar, status)
        .query("UPDATE orders SET status = @status OUTPUT INSERTED.id, INSERTED.userId, INSERTED.status WHERE id = @id");
    if (updated.recordset.length === 0) {
        return res.status(404).json({ message: t(lang, "notFound") });
    }
    const row = updated.recordset[0];
    const itemsRows = await dbPool
        .request()
        .input("orderId", mssql_1.default.Int, id)
        .query("SELECT productId, quantity FROM order_items WHERE orderId = @orderId");
    const order = { id: row.id, userId: row.userId, status: row.status, items: itemsRows.recordset };
    if (status === "Paid") {
        publish("order.paid", order);
    }
    return res.json({ order });
});
const bootstrap = async () => {
    const host = process.env.DB_HOST || "sqlserver";
    const dbPort = Number(process.env.DB_PORT || 1433);
    const user = process.env.DB_USER || "sa";
    const password = process.env.DB_PASSWORD || "YourStrong@Passw0rd";
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
    IF OBJECT_ID('orders', 'U') IS NULL
    BEGIN
      CREATE TABLE orders (
        id INT IDENTITY(1,1) PRIMARY KEY,
        userId INT NOT NULL,
        status NVARCHAR(50) NOT NULL
      );
    END;
    IF OBJECT_ID('order_items', 'U') IS NULL
    BEGIN
      CREATE TABLE order_items (
        id INT IDENTITY(1,1) PRIMARY KEY,
        orderId INT NOT NULL,
        productId INT NOT NULL,
        quantity INT NOT NULL
      );
    END;
  `);
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
