"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const express_1 = __importDefault(require("express"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
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
const products = [
    {
        id: 1,
        name: "Gaming Laptop",
        description: "High-performance laptop with RTX graphics",
        price: 1450,
        category: "Electronics"
    },
    {
        id: 2,
        name: "Wireless Mouse",
        description: "Ergonomic mouse with silent click",
        price: 35,
        category: "Electronics"
    },
    {
        id: 3,
        name: "Office Chair",
        description: "Adjustable lumbar support chair",
        price: 220,
        category: "Furniture"
    },
    {
        id: 4,
        name: "Mechanical Keyboard",
        description: "RGB backlit keyboard with blue switches",
        price: 95,
        category: "Electronics"
    },
    {
        id: 5,
        name: "Water Bottle",
        description: "Insulated stainless steel bottle 750ml",
        price: 18,
        category: "Accessories"
    },
    {
        id: 6,
        name: "Backpack",
        description: "Water-resistant daily backpack with laptop sleeve",
        price: 60,
        category: "Accessories"
    },
    {
        id: 7,
        name: "Desk Lamp",
        description: "LED lamp with brightness control",
        price: 42,
        category: "Home"
    },
    {
        id: 8,
        name: "Running Shoes",
        description: "Lightweight shoes for daily training",
        price: 110,
        category: "Sports"
    }
];
let nextId = products.length + 1;
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
    const filtered = products.filter((p) => {
        const categoryOk = category ? p.category.toLowerCase() === category.toLowerCase() : true;
        const queryOk = q
            ? p.name.toLowerCase().includes(q.toLowerCase()) ||
                p.description.toLowerCase().includes(q.toLowerCase())
            : true;
        return categoryOk && queryOk;
    });
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
    const product = products.find((p) => p.id === id);
    if (!product) {
        return res.status(404).json({ message: t(lang, "notFound") });
    }
    await redis.set(cacheKey, JSON.stringify(product), { EX: cacheTtl });
    return res.json({ source: "db", product });
});
app.post("/products", auth, requireAdmin, async (req, res) => {
    const { name, description, price, category } = req.body;
    const product = { id: nextId++, name, description, price, category };
    products.push(product);
    await invalidateProductsCache();
    return res.status(201).json({ product });
});
app.put("/products/:id", auth, requireAdmin, async (req, res) => {
    const lang = detectLang(req.header("accept-language"));
    const id = Number(req.params.id);
    const idx = products.findIndex((p) => p.id === id);
    if (idx === -1) {
        return res.status(404).json({ message: t(lang, "notFound") });
    }
    products[idx] = { ...products[idx], ...req.body, id };
    await invalidateProductsCache();
    return res.json({ product: products[idx] });
});
app.delete("/products/:id", auth, requireAdmin, async (req, res) => {
    const lang = detectLang(req.header("accept-language"));
    const id = Number(req.params.id);
    const idx = products.findIndex((p) => p.id === id);
    if (idx === -1) {
        return res.status(404).json({ message: t(lang, "notFound") });
    }
    products.splice(idx, 1);
    await invalidateProductsCache();
    return res.status(204).send();
});
redis
    .connect()
    .catch((error) => {
    console.error("product-service redis connect failed:", error);
})
    .finally(() => {
    app.listen(port, () => {
        console.log(`product-service listening on port ${port}`);
    });
});
