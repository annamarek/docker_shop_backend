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
const redis_1 = require("redis");
dotenv_1.default.config();
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use((0, morgan_1.default)("dev"));
const port = Number(process.env.PORT || 4003);
const jwtSecret = process.env.JWT_SECRET || "secret";
const redisUrl = process.env.REDIS_URL || "redis://redis:6379";
const cacheTtl = Number(process.env.CACHE_TTL || 120);
const redis = (0, redis_1.createClient)({ url: redisUrl });
redis.on("error", (err) => console.error("product-service redis error:", err));
let dbPool = null;
const messages = {
    en: {
        health: "Product service is running",
        unauthorized: "Unauthorized",
        forbidden: "Forbidden",
        notFound: "Product not found"
    },
    uk: {
        health: "Сервіс продуктів працює",
        unauthorized: "Неавторизовано",
        forbidden: "Доступ заборонено",
        notFound: "Продукт не знайдено"
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
const requireAdmin = (req, res, next) => {
    const lang = detectLang(req.header("accept-language"));
    if (req.user?.role !== "Admin") {
        res.status(403).json({ message: t(lang, "forbidden") });
        return;
    }
    next();
};
const getListCacheKey = (q, category) => `products:list:${q || ""}:${category || ""}`;
const getDetailsCacheKey = (id) => `products:item:${id}`;
const invalidateProductsCache = async () => {
    const keys = await redis.keys("products:*");
    if (keys.length > 0) {
        await redis.del(keys);
    }
};
app.get("/health", (req, res) => {
    const lang = detectLang(req.header("accept-language"));
    res.json({ message: t(lang, "health") });
});
app.get("/products", async (req, res) => {
    const q = String(req.query.q || "");
    const category = String(req.query.category || "");
    const cacheKey = getListCacheKey(q, category);
    const cached = await redis.get(cacheKey);
    if (cached) {
        return res.json({ source: "cache", products: JSON.parse(cached) });
    }
    if (!dbPool) {
        return res.status(503).json({ message: "Database is not ready" });
    }
    const query = `
    SELECT id, name, description, price, category
    FROM products
    WHERE (@category = '' OR LOWER(category) = LOWER(@category))
      AND (
        @q = ''
        OR LOWER(name) LIKE '%' + LOWER(@q) + '%'
        OR LOWER(description) LIKE '%' + LOWER(@q) + '%'
      )
    ORDER BY id
  `;
    const dbResult = await dbPool
        .request()
        .input("category", mssql_1.default.NVarChar, category)
        .input("q", mssql_1.default.NVarChar, q)
        .query(query);
    const filtered = dbResult.recordset;
    await redis.set(cacheKey, JSON.stringify(filtered), { EX: cacheTtl });
    return res.json({ source: "db", products: filtered });
});
app.get("/products/:id", async (req, res) => {
    const lang = detectLang(req.header("accept-language"));
    const id = Number(req.params.id);
    const cacheKey = getDetailsCacheKey(id);
    const cached = await redis.get(cacheKey);
    if (cached) {
        return res.json({ source: "cache", product: JSON.parse(cached) });
    }
    if (!dbPool) {
        return res.status(503).json({ message: "Database is not ready" });
    }
    const dbResult = await dbPool
        .request()
        .input("id", mssql_1.default.Int, id)
        .query("SELECT id, name, description, price, category FROM products WHERE id = @id");
    const product = dbResult.recordset[0];
    if (!product) {
        return res.status(404).json({ message: t(lang, "notFound") });
    }
    await redis.set(cacheKey, JSON.stringify(product), { EX: cacheTtl });
    return res.json({ source: "db", product });
});
app.get("/categories", async (_req, res) => {
    if (!dbPool) {
        return res.status(503).json({ message: "Database is not ready" });
    }
    const result = await dbPool.query("SELECT id, name FROM categories ORDER BY name");
    return res.json({ categories: result.recordset });
});
app.post("/categories", auth, requireAdmin, async (req, res) => {
    const { name } = req.body;
    if (!dbPool) {
        return res.status(503).json({ message: "Database is not ready" });
    }
    if (!name?.trim()) {
        return res.status(400).json({ message: "Category name is required" });
    }
    const exists = await dbPool
        .request()
        .input("name", mssql_1.default.NVarChar, name.trim())
        .query("SELECT TOP 1 id, name FROM categories WHERE LOWER(name) = LOWER(@name)");
    if (exists.recordset.length > 0) {
        return res.status(409).json({ message: "Category already exists" });
    }
    const inserted = await dbPool
        .request()
        .input("name", mssql_1.default.NVarChar, name.trim())
        .query("INSERT INTO categories (name) OUTPUT INSERTED.id, INSERTED.name VALUES (@name)");
    return res.status(201).json({ category: inserted.recordset[0] });
});
app.post("/products", auth, requireAdmin, async (req, res) => {
    const { name, description, price, category } = req.body;
    if (!dbPool) {
        return res.status(503).json({ message: "Database is not ready" });
    }
    const categoryExists = await dbPool
        .request()
        .input("category", mssql_1.default.NVarChar, category)
        .query("SELECT TOP 1 id FROM categories WHERE LOWER(name) = LOWER(@category)");
    if (categoryExists.recordset.length === 0) {
        return res.status(400).json({ message: "Category does not exist" });
    }
    const inserted = await dbPool
        .request()
        .input("name", mssql_1.default.NVarChar, name)
        .input("description", mssql_1.default.NVarChar, description)
        .input("price", mssql_1.default.Decimal(10, 2), price)
        .input("category", mssql_1.default.NVarChar, category)
        .query("INSERT INTO products (name, description, price, category) OUTPUT INSERTED.id, INSERTED.name, INSERTED.description, INSERTED.price, INSERTED.category VALUES (@name, @description, @price, @category)");
    const product = inserted.recordset[0];
    await invalidateProductsCache();
    return res.status(201).json({ product });
});
app.put("/products/:id", auth, requireAdmin, async (req, res) => {
    const lang = detectLang(req.header("accept-language"));
    const id = Number(req.params.id);
    if (!dbPool) {
        return res.status(503).json({ message: "Database is not ready" });
    }
    const existing = await dbPool
        .request()
        .input("id", mssql_1.default.Int, id)
        .query("SELECT id, name, description, price, category FROM products WHERE id = @id");
    if (existing.recordset.length === 0) {
        return res.status(404).json({ message: t(lang, "notFound") });
    }
    const merged = { ...existing.recordset[0], ...req.body, id };
    await dbPool
        .request()
        .input("id", mssql_1.default.Int, id)
        .input("name", mssql_1.default.NVarChar, merged.name)
        .input("description", mssql_1.default.NVarChar, merged.description)
        .input("price", mssql_1.default.Decimal(10, 2), merged.price)
        .input("category", mssql_1.default.NVarChar, merged.category)
        .query("UPDATE products SET name = @name, description = @description, price = @price, category = @category WHERE id = @id");
    await invalidateProductsCache();
    return res.json({ product: merged });
});
app.delete("/products/:id", auth, requireAdmin, async (req, res) => {
    const lang = detectLang(req.header("accept-language"));
    const id = Number(req.params.id);
    if (!dbPool) {
        return res.status(503).json({ message: "Database is not ready" });
    }
    const deleted = await dbPool.request().input("id", mssql_1.default.Int, id).query("DELETE FROM products OUTPUT DELETED.id WHERE id = @id");
    if (deleted.recordset.length === 0) {
        return res.status(404).json({ message: t(lang, "notFound") });
    }
    await invalidateProductsCache();
    return res.status(204).send();
});
const ensureDb = async () => {
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
    IF OBJECT_ID('categories', 'U') IS NULL
    BEGIN
      CREATE TABLE categories (
        id INT IDENTITY(1,1) PRIMARY KEY,
        name NVARCHAR(255) NOT NULL UNIQUE
      );
    END;
    IF OBJECT_ID('products', 'U') IS NULL
    BEGIN
      CREATE TABLE products (
        id INT IDENTITY(1,1) PRIMARY KEY,
        name NVARCHAR(255) NOT NULL,
        description NVARCHAR(MAX) NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        category NVARCHAR(255) NOT NULL
      );
    END
  `);
    const countResult = await dbPool.query("SELECT COUNT(*) AS count FROM products");
    if (countResult.recordset[0].count === 0) {
        await dbPool.query(`
      INSERT INTO products (name, description, price, category) VALUES
      ('Gaming Laptop', 'High-performance laptop with RTX graphics', 1450, 'Electronics'),
      ('Wireless Mouse', 'Ergonomic mouse with silent click', 35, 'Electronics'),
      ('Office Chair', 'Adjustable lumbar support chair', 220, 'Furniture'),
      ('Mechanical Keyboard', 'RGB backlit keyboard with blue switches', 95, 'Electronics'),
      ('Water Bottle', 'Insulated stainless steel bottle 750ml', 18, 'Accessories'),
      ('Backpack', 'Water-resistant daily backpack with laptop sleeve', 60, 'Accessories'),
      ('Desk Lamp', 'LED lamp with brightness control', 42, 'Home'),
      ('Running Shoes', 'Lightweight shoes for daily training', 110, 'Sports')
    `);
    }
    await dbPool.query(`
    INSERT INTO categories (name)
    SELECT DISTINCT p.category
    FROM products p
    WHERE NOT EXISTS (
      SELECT 1 FROM categories c WHERE LOWER(c.name) = LOWER(p.category)
    )
  `);
};
redis
    .connect()
    .catch((error) => {
    console.error("product-service redis connect failed:", error);
})
    .finally(async () => {
    try {
        await ensureDb();
    }
    catch (error) {
        console.error("product-service mssql init failed:", error);
    }
    app.listen(port, () => {
        console.log(`product-service listening on port ${port}`);
    });
});
