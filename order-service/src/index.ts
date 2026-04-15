import amqp from "amqplib";
import cors from "cors";
import dotenv from "dotenv";
import express, { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
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

const orders: Order[] = [];
let nextId = 1;
let channel: amqp.Channel | null = null;

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

app.post("/orders", auth, (req: AuthRequest, res) => {
  const userId = Number(req.user?.sub);
  const items = req.body.items as Array<{ productId: number; quantity: number }>;
  const order: Order = { id: nextId++, userId, items, status: "Pending" };
  orders.push(order);
  publish("order.created", order);
  return res.status(201).json({ order });
});

app.get("/orders", auth, (req: AuthRequest, res) => {
  const role = req.user?.role;
  const userId = Number(req.user?.sub);
  if (role === "Admin") {
    return res.json({ orders });
  }
  return res.json({ orders: orders.filter((o) => o.userId === userId) });
});

app.patch("/orders/:id/status", auth, (req: AuthRequest, res) => {
  const lang = detectLang(req.header("accept-language"));
  if (req.user?.role !== "Admin") {
    return res.status(403).json({ message: t(lang, "forbidden") });
  }

  const id = Number(req.params.id);
  const status = req.body.status as OrderStatus;
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

const bootstrap = async (): Promise<void> => {
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
