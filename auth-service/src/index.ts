import amqp from "amqplib";
import bcrypt from "bcryptjs";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import jwt from "jsonwebtoken";
import mssql from "mssql";
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

let channel: amqp.Channel | null = null;
let dbPool: mssql.ConnectionPool | null = null;

const messages: Record<Lang, Record<string, string>> = {
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

  if (!dbPool) {
    return res.status(503).json({ message: "Database is not ready" });
  }

  const existing = await dbPool.request().input("email", mssql.NVarChar, email).query<User>(
    "SELECT TOP 1 id, name, email, passwordHash, role FROM users WHERE email = @email"
  );
  if (existing.recordset.length > 0) {
    return res.status(409).json({ message: t(lang, "emailTaken") });
  }

  if (role === "Admin") {
    return res.status(403).json({ message: t(lang, "adminRegisterForbidden") });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const userRole: Role = "Customer";

  const inserted = await dbPool
    .request()
    .input("name", mssql.NVarChar, name)
    .input("email", mssql.NVarChar, email)
    .input("passwordHash", mssql.NVarChar, passwordHash)
    .input("role", mssql.NVarChar, userRole)
    .query<User>(
      "INSERT INTO users (name, email, passwordHash, role) OUTPUT INSERTED.id, INSERTED.name, INSERTED.email, INSERTED.passwordHash, INSERTED.role VALUES (@name, @email, @passwordHash, @role)"
    );
  const user = inserted.recordset[0];

  publish("user.registered", { id: user.id, name: user.name, email: user.email, role: user.role });

  return res.status(201).json({
    message: t(lang, "registered"),
    user: { id: user.id, name: user.name, email: user.email, role: user.role }
  });
});

app.post("/login", async (req, res) => {
  const lang = detectLang(req.header("accept-language"));
  const { email, password } = req.body as { email: string; password: string };

  if (!dbPool) {
    return res.status(503).json({ message: "Database is not ready" });
  }

  const result = await dbPool.request().input("email", mssql.NVarChar, email).query<User>(
    "SELECT TOP 1 id, name, email, passwordHash, role FROM users WHERE email = @email"
  );
  const user = result.recordset[0];
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

const connectDb = async (): Promise<void> => {
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
    options: {
      encrypt: false,
      trustServerCertificate: true
    }
  };

  const masterPool = await mssql.connect({ ...baseConfig, database: "master" });
  await masterPool
    .request()
    .input("dbName", mssql.NVarChar, dbName)
    .query("IF DB_ID(@dbName) IS NULL EXEC('CREATE DATABASE [' + @dbName + ']')");
  await masterPool.close();

  dbPool = await mssql.connect({ ...baseConfig, database: dbName });
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
    .input("email", mssql.NVarChar, adminEmail)
    .query<User>("SELECT TOP 1 id, name, email, passwordHash, role FROM users WHERE email = @email");

  if (existingAdmin.recordset.length === 0) {
    const adminHash = await bcrypt.hash(adminPassword, 10);
    await dbPool
      .request()
      .input("name", mssql.NVarChar, adminName)
      .input("email", mssql.NVarChar, adminEmail)
      .input("passwordHash", mssql.NVarChar, adminHash)
      .input("role", mssql.NVarChar, "Admin")
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
