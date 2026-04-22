import amqp from "amqplib";
import cors from "cors";
import dotenv from "dotenv";
import express, { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import mssql from "mssql";
import morgan from "morgan";

dotenv.config();

type Role = "Admin" | "Customer";
type Lang = "en" | "uk";
type OrderStatus = "Pending" | "Paid" | "Shipped" | "Cancelled";

type JwtPayload = {
  sub: number;
  email: string;
  role: Role;
  name: string;
};

type Order = {
  id: number;
  userId: number;
  items: Array<{ productId: number; quantity: number }>;
  status: OrderStatus;
};

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

const port = Number(process.env.PORT || 4004);
const jwtSecret = process.env.JWT_SECRET || "secret";
const rabbitUrl = process.env.RABBITMQ_URL || "amqp://rabbitmq:5672";
const exchange = process.env.RABBITMQ_EXCHANGE || "shop.events";

let channel: amqp.Channel | null = null;
let dbPool: mssql.ConnectionPool | null = null;

const messages: Record<Lang, Record<string, string>> = {
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

const detectLang = (header?: string): Lang =>
  header?.toLowerCase().startsWith("uk") ? "uk" : "en";
const t = (lang: Lang, key: string): string => messages[lang][key] ?? key;

type AuthRequest = Request & { user?: JwtPayload };
const auth = (req: AuthRequest, res: Response, next: NextFunction): void => {
  const lang = detectLang(req.header("accept-language"));
  const token = req.header("authorization")?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ message: t(lang, "unauthorized") });
    return;
  }
  try {
    req.user = jwt.verify(token, jwtSecret) as unknown as JwtPayload;
    next();
  } catch {
    res.status(401).json({ message: t(lang, "unauthorized") });
  }
};

const publish = (routingKey: string, payload: unknown): void => {
  if (!channel) return;
  channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(payload)));
};

app.get("/health", (req, res) => {
  const lang = detectLang(req.header("accept-language"));
  res.json({ message: t(lang, "health") });
});

app.post("/orders", auth, async (req: AuthRequest, res) => {
  const userId = Number(req.user?.sub);
  const items = req.body.items as Array<{ productId: number; quantity: number }>;
  if (!dbPool) {
    return res.status(503).json({ message: "Database is not ready" });
  }

  const insertOrder = await dbPool
    .request()
    .input("userId", mssql.Int, userId)
    .input("status", mssql.NVarChar, "Pending")
    .query<{ id: number }>("INSERT INTO orders (userId, status) OUTPUT INSERTED.id VALUES (@userId, @status)");
  const orderId = insertOrder.recordset[0].id;

  for (const item of items) {
    await dbPool
      .request()
      .input("orderId", mssql.Int, orderId)
      .input("productId", mssql.Int, item.productId)
      .input("quantity", mssql.Int, item.quantity)
      .query("INSERT INTO order_items (orderId, productId, quantity) VALUES (@orderId, @productId, @quantity)");
  }
  const order: Order = { id: orderId, userId, items, status: "Pending" };
  publish("order.created", order);
  return res.status(201).json({ order });
});

app.get("/orders", auth, async (req: AuthRequest, res) => {
  if (!dbPool) {
    return res.status(503).json({ message: "Database is not ready" });
  }
  const role = req.user?.role;
  const userId = Number(req.user?.sub);

  const query =
    role === "Admin"
      ? "SELECT id, userId, status FROM orders ORDER BY id DESC"
      : "SELECT id, userId, status FROM orders WHERE userId = @userId ORDER BY id DESC";
  const ordersResult =
    role === "Admin"
      ? await dbPool.request().query<{ id: number; userId: number; status: OrderStatus }>(query)
      : await dbPool
          .request()
          .input("userId", mssql.Int, userId)
          .query<{ id: number; userId: number; status: OrderStatus }>(query);
  const orderRows = ordersResult.recordset;
  if (orderRows.length === 0) {
    return res.json({ orders: [] });
  }

  const idsCsv = orderRows.map((o) => o.id).join(",");
  const itemsResult = await dbPool.query<{ orderId: number; productId: number; quantity: number }>(
    `SELECT orderId, productId, quantity FROM order_items WHERE orderId IN (${idsCsv})`
  );

  const itemsByOrder = new Map<number, Array<{ productId: number; quantity: number }>>();
  for (const row of itemsResult.recordset) {
    const existing = itemsByOrder.get(row.orderId) || [];
    existing.push({ productId: row.productId, quantity: row.quantity });
    itemsByOrder.set(row.orderId, existing);
  }

  const orders: Order[] = orderRows.map((row) => ({
    id: row.id,
    userId: row.userId,
    status: row.status,
    items: itemsByOrder.get(row.id) || []
  }));
  return res.json({ orders });
});

app.patch("/orders/:id/status", auth, async (req: AuthRequest, res) => {
  const lang = detectLang(req.header("accept-language"));
  if (req.user?.role !== "Admin") {
    return res.status(403).json({ message: t(lang, "forbidden") });
  }
  if (!dbPool) {
    return res.status(503).json({ message: "Database is not ready" });
  }

  const id = Number(req.params.id);
  const status = req.body.status as OrderStatus;
  const updated = await dbPool
    .request()
    .input("id", mssql.Int, id)
    .input("status", mssql.NVarChar, status)
    .query<{ id: number; userId: number; status: OrderStatus }>(
      "UPDATE orders SET status = @status OUTPUT INSERTED.id, INSERTED.userId, INSERTED.status WHERE id = @id"
    );
  if (updated.recordset.length === 0) {
    return res.status(404).json({ message: t(lang, "notFound") });
  }
  const row = updated.recordset[0];
  const itemsRows = await dbPool
    .request()
    .input("orderId", mssql.Int, id)
    .query<{ productId: number; quantity: number }>(
      "SELECT productId, quantity FROM order_items WHERE orderId = @orderId"
    );
  const order: Order = { id: row.id, userId: row.userId, status: row.status, items: itemsRows.recordset };
  if (status === "Paid") {
    publish("order.paid", order);
  }

  return res.json({ order });
});

const bootstrap = async (): Promise<void> => {
  const host = process.env.DB_HOST || "sqlserver";
  const dbPort = Number(process.env.DB_PORT || 1433);
  const user = process.env.DB_USER || "sa";
  const password = process.env.DB_PASSWORD || "StrongPass123!";
  const dbName = process.env.DB_NAME || "docker_shop";
  const baseConfig: mssql.config = {
    user,
    password,
    server: host,
    port: dbPort,
    options: { encrypt: false, trustServerCertificate: true }
  };

  const masterPool = await mssql.connect({ ...baseConfig, database: "master" });
  await masterPool
    .request()
    .input("dbName", mssql.NVarChar, dbName)
    .query("IF DB_ID(@dbName) IS NULL EXEC('CREATE DATABASE [' + @dbName + ']')");
  await masterPool.close();
  dbPool = await mssql.connect({ ...baseConfig, database: dbName });
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

  const connection = await amqp.connect(rabbitUrl);
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
