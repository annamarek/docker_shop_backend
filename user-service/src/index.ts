import cors from "cors";
import dotenv from "dotenv";
import express, { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import mssql from "mssql";
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
let dbPool: mssql.ConnectionPool | null = null;

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
  if (!dbPool) {
    return res.status(503).json({ message: "Database is not ready" });
  }
  const userId = Number(req.user?.sub);
  dbPool
    .request()
    .input("id", mssql.Int, userId)
    .query<UserProfile>("SELECT id, name, email, role FROM users WHERE id = @id")
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

app.get("/users/:id", auth, (req: AuthRequest, res) => {
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
    .input("id", mssql.Int, targetId)
    .query<UserProfile>("SELECT id, name, email, role FROM users WHERE id = @id")
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

app.get("/users", auth, async (req: AuthRequest, res) => {
  const lang = detectLang(req.header("accept-language"));
  if (req.user?.role !== "Admin") {
    return res.status(403).json({ message: t(lang, "forbidden") });
  }
  if (!dbPool) {
    return res.status(503).json({ message: "Database is not ready" });
  }
  const result = await dbPool.query<UserProfile>("SELECT id, name, email, role FROM users ORDER BY id");
  return res.json({ users: result.recordset });
});

app.patch("/users/:id/role", auth, async (req: AuthRequest, res) => {
  const lang = detectLang(req.header("accept-language"));
  if (req.user?.role !== "Admin") {
    return res.status(403).json({ message: t(lang, "forbidden") });
  }
  if (!dbPool) {
    return res.status(503).json({ message: "Database is not ready" });
  }

  const id = Number(req.params.id);
  const role = String(req.body.role || "") as Role;
  if (role !== "Admin" && role !== "Customer") {
    return res.status(400).json({ message: "Invalid role" });
  }

  const result = await dbPool
    .request()
    .input("id", mssql.Int, id)
    .input("role", mssql.NVarChar, role)
    .query<UserProfile>(
      "UPDATE users SET role = @role OUTPUT INSERTED.id, INSERTED.name, INSERTED.email, INSERTED.role WHERE id = @id"
    );
  const user = result.recordset[0];
  if (!user) {
    return res.status(404).json({ message: t(lang, "notFound") });
  }

  return res.json({ user });
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
