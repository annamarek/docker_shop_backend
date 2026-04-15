import amqp from "amqplib";
import cors from "cors";
import dotenv from "dotenv";
import express, { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import morgan from "morgan";

dotenv.config();

type Role = "Admin" | "Customer";
type Lang = "en" | "uk";

type UserProfile = {
  id: number;
  name: string;
  email: string;
  role: Role;
};

type JwtPayload = {
  sub: number;
  email: string;
  role: Role;
  name: string;
};

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

const port = Number(process.env.PORT || 4002);
const jwtSecret = process.env.JWT_SECRET || "secret";
const rabbitUrl = process.env.RABBITMQ_URL || "amqp://rabbitmq:5672";
const exchange = process.env.RABBITMQ_EXCHANGE || "shop.events";

const users = new Map<number, UserProfile>();

const messages: Record<Lang, Record<string, string>> = {
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

app.get("/health", (req, res) => {
  const lang = detectLang(req.header("accept-language"));
  res.json({ message: t(lang, "health") });
});

app.get("/me", auth, (req: AuthRequest, res) => {
  const lang = detectLang(req.header("accept-language"));
  const user = users.get(Number(req.user?.sub));
  if (!user) {
    return res.status(404).json({ message: t(lang, "notFound") });
  }

  return res.json({ user });
});

app.get("/users/:id", auth, (req: AuthRequest, res) => {
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

const bootstrap = async (): Promise<void> => {
  const connection = await amqp.connect(rabbitUrl);
  const channel = await connection.createChannel();
  await channel.assertExchange(exchange, "topic", { durable: false });
  const queue = await channel.assertQueue("", { exclusive: true });
  await channel.bindQueue(queue.queue, exchange, "user.registered");

  channel.consume(queue.queue, (msg) => {
    if (!msg) return;
    const payload = JSON.parse(msg.content.toString()) as UserProfile;
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
