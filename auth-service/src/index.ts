import amqp from "amqplib";
import bcrypt from "bcryptjs";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import jwt from "jsonwebtoken";
import morgan from "morgan";

dotenv.config();

type Role = "Admin" | "Customer";
type Lang = "en" | "uk";

type User = {
  id: number;
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
};

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

const port = Number(process.env.PORT || 4001);
const jwtSecret = process.env.JWT_SECRET || "secret";
const rabbitUrl = process.env.RABBITMQ_URL || "amqp://rabbitmq:5672";
const exchange = process.env.RABBITMQ_EXCHANGE || "shop.events";

const users: User[] = [];
let nextId = 1;
let channel: amqp.Channel | null = null;

const messages: Record<Lang, Record<string, string>> = {
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

const detectLang = (header?: string): Lang =>
  header?.toLowerCase().startsWith("uk") ? "uk" : "en";

const t = (lang: Lang, key: string): string => messages[lang][key] ?? key;

const connectRabbit = async (): Promise<void> => {
  const connection = await amqp.connect(rabbitUrl);
  channel = await connection.createChannel();
  await channel.assertExchange(exchange, "topic", { durable: false });
};

const publish = (routingKey: string, payload: unknown): void => {
  if (!channel) return;
  channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(payload)));
};

app.get("/health", (req, res) => {
  const lang = detectLang(req.header("accept-language"));
  res.json({ message: t(lang, "health") });
});

app.post("/register", async (req, res) => {
  const lang = detectLang(req.header("accept-language"));
  const { name, email, password, role } = req.body as {
    name: string;
    email: string;
    password: string;
    role?: Role;
  };

  if (users.some((u) => u.email === email)) {
    return res.status(409).json({ message: t(lang, "emailTaken") });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const userRole: Role = role === "Admin" ? "Admin" : "Customer";

  const user: User = { id: nextId++, name, email, passwordHash, role: userRole };
  users.push(user);

  publish("user.registered", { id: user.id, name: user.name, email: user.email, role: user.role });

  return res.status(201).json({
    message: t(lang, "registered"),
    user: { id: user.id, name: user.name, email: user.email, role: user.role }
  });
});

app.post("/login", async (req, res) => {
  const lang = detectLang(req.header("accept-language"));
  const { email, password } = req.body as { email: string; password: string };

  const user = users.find((u) => u.email === email);
  if (!user) {
    return res.status(401).json({ message: t(lang, "invalidCredentials") });
  }

  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) {
    return res.status(401).json({ message: t(lang, "invalidCredentials") });
  }

  const token = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, name: user.name },
    jwtSecret,
    { expiresIn: "12h" }
  );

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
