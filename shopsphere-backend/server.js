require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const mysql = require("mysql2/promise");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 5000;
const SERVICE_NAME = "shopsphere-backend";
const START_TIME = Date.now();

// -------------------------
// State flags (used by ECS/ALB health checks)
// -------------------------

let isReady = false;   // becomes true once DB init succeeds
let isShuttingDown = false;

// -------------------------
// Structured logger
// -------------------------
// ECS ships stdout/stderr straight to CloudWatch Logs, so every line
// is a JSON object — greppable and filterable in Logs Insights,
// instead of free-text console.log spam.

function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    message,
    ...meta
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else console.log(line);
}

// -------------------------
// Middleware
// -------------------------

app.use(helmet());               // sensible security headers by default
app.use(compression());          // gzip responses
app.use(cors());
app.use(express.json());

// Request ID + timing — attaches a correlation id to every request so a
// single request can be traced across load balancer, app, and (if you
// add one later) downstream service logs.
app.use((req, res, next) => {
  req.requestId = req.headers["x-request-id"] || crypto.randomUUID();
  res.setHeader("X-Request-Id", req.requestId);

  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    res.setHeader("X-Response-Time", `${durationMs.toFixed(1)}ms`);
    log("info", "request completed", {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(1))
    });
  });

  next();
});

// Reject new traffic once a shutdown has started, so in-flight ECS task
// draining doesn't race with new requests hitting a pool that's closing.
app.use((req, res, next) => {
  if (isShuttingDown) {
    res.set("Connection", "close");
    return res.status(503).json({ error: "Server is shutting down" });
  }
  next();
});

// -------------------------
// MySQL Connection Pool
// (unchanged architecture — same schema, same table, same DB)
// -------------------------

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "shopsphere",

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// -------------------------
// Database Initialization
// -------------------------
// Retries with backoff instead of crashing on the first attempt. This
// matters on ECS: RDS, the ENI, and the task can all become reachable
// at slightly different times, especially on cold starts or failovers.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWithRetry(maxAttempts = 8, baseDelayMs = 1000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const connection = await pool.getConnection();
      connection.release();
      log("info", "connected to MySQL", { attempt });
      return;
    } catch (error) {
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      log("error", "MySQL connection attempt failed", {
        attempt,
        maxAttempts,
        nextRetryMs: attempt < maxAttempts ? delay : null,
        error: error.message
      });

      if (attempt === maxAttempts) {
        throw new Error(`Could not reach MySQL after ${maxAttempts} attempts`);
      }
      await sleep(delay);
    }
  }
}

async function initializeDatabase() {
  await connectWithRetry();

  // Create products table (same DDL as migrations/init.sql)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sku VARCHAR(64) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      description VARCHAR(500),
      category VARCHAR(100) NOT NULL,
      price DECIMAL(10,2) NOT NULL,
      stock_quantity INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_category (category),
      INDEX idx_is_active (is_active)
    )
  `);

  log("info", "products table ready");

  const [rows] = await pool.query("SELECT COUNT(*) AS count FROM products");

  if (rows[0].count === 0) {
    await pool.query(`
      INSERT INTO products (sku, name, description, category, price, stock_quantity)
      VALUES
        ('ELEC-LAP-001', 'Laptop', '14-inch ultrabook, 16GB RAM, 512GB SSD', 'Electronics', 79999.00, 24),
        ('ELEC-HDP-002', 'Headphones', 'Wireless over-ear, active noise cancellation', 'Electronics', 4999.00, 120),
        ('ELEC-KBD-003', 'Keyboard', 'Mechanical, hot-swappable switches', 'Electronics', 2999.00, 65),
        ('ELEC-MOU-004', 'Wireless Mouse', 'Ergonomic, 2.4GHz + Bluetooth', 'Electronics', 1499.00, 8),
        ('HOME-LMP-005', 'Desk Lamp', 'LED, adjustable color temperature', 'Home', 1299.00, 0),
        ('HOME-CHR-006', 'Office Chair', 'Mesh back, adjustable lumbar support', 'Home', 8999.00, 15)
    `);
    log("info", "initial products inserted");
  } else {
    log("info", "products already exist — skipping seed", { count: rows[0].count });
  }
}

// -------------------------
// Tiny in-memory response cache
// -------------------------
// GET /api/products is read-heavy and rarely changes. A short TTL cache
// takes repeat load off RDS without adding a cache tier to the
// architecture. Any write endpoint you add later should call
// invalidateProductsCache().

const CACHE_TTL_MS = 5000;
const cacheStore = new Map(); // key -> { data, expiresAt }

function getCached(key) {
  const entry = cacheStore.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.data;
  return null;
}

function setCached(key, data) {
  cacheStore.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

function invalidateProductsCache() {
  cacheStore.clear();
}

// -------------------------
// Health Checks
// -------------------------
// Split into liveness (process is up) and readiness (DB is reachable
// and the app can actually serve traffic). Point the ALB/ECS health
// check at /health/ready so a task with a dead DB connection gets
// pulled out of rotation instead of serving 500s.

app.get("/health/live", (req, res) => {
  res.status(200).json({
    status: "UP",
    service: SERVICE_NAME,
    uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000)
  });
});

app.get("/health/ready", (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ status: "SHUTTING_DOWN" });
  }
  if (!isReady) {
    return res.status(503).json({ status: "NOT_READY" });
  }
  res.status(200).json({ status: "READY", service: SERVICE_NAME });
});

// Backward-compatible alias for the original /health path
app.get("/health", (req, res) => {
  res.status(200).json({ status: "UP", service: SERVICE_NAME });
});

// -------------------------
// Products API
// -------------------------

const PRODUCT_COLUMNS = `
  id, sku, name, description, category, price, stock_quantity, is_active, updated_at
`;

app.get("/api/products", async (req, res) => {
  const { category } = req.query;
  const cacheKey = `products:${category || "all"}`;

  const cached = getCached(cacheKey);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    return res.status(200).json(cached);
  }

  try {
    let rows;
    if (category) {
      [rows] = await pool.query(
        `SELECT ${PRODUCT_COLUMNS} FROM products WHERE is_active = 1 AND category = ? ORDER BY id`,
        [category]
      );
    } else {
      [rows] = await pool.query(
        `SELECT ${PRODUCT_COLUMNS} FROM products WHERE is_active = 1 ORDER BY id`
      );
    }

    setCached(cacheKey, rows);
    res.setHeader("X-Cache", "MISS");
    res.status(200).json(rows);
  } catch (error) {
    log("error", "database query failed", {
      requestId: req.requestId,
      route: "/api/products",
      error: error.message
    });

    res.status(500).json({
      error: "Unable to retrieve products",
      requestId: req.requestId
    });
  }
});

app.get("/api/products/:id", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ? AND is_active = 1`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.status(200).json(rows[0]);
  } catch (error) {
    log("error", "database query failed", {
      requestId: req.requestId,
      route: "/api/products/:id",
      error: error.message
    });

    res.status(500).json({
      error: "Unable to retrieve product",
      requestId: req.requestId
    });
  }
});

app.get("/api/categories", async (req, res) => {
  const cacheKey = "categories";
  const cached = getCached(cacheKey);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    return res.status(200).json(cached);
  }

  try {
    const [rows] = await pool.query(
      "SELECT category, COUNT(*) AS productCount FROM products WHERE is_active = 1 GROUP BY category ORDER BY category"
    );
    setCached(cacheKey, rows);
    res.setHeader("X-Cache", "MISS");
    res.status(200).json(rows);
  } catch (error) {
    log("error", "database query failed", {
      requestId: req.requestId,
      route: "/api/categories",
      error: error.message
    });
    res.status(500).json({ error: "Unable to retrieve categories", requestId: req.requestId });
  }
});

// -------------------------
// 404 + centralized error handler
// -------------------------

app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.originalUrl });
});

app.use((err, req, res, next) => {
  log("error", "unhandled request error", {
    requestId: req?.requestId,
    error: err.message,
    stack: err.stack
  });
  res.status(500).json({ error: "Internal server error" });
});

// -------------------------
// Process-level safety nets
// -------------------------
// Without these, one uncaught error can crash the Fargate task instantly
// with no log context — these guarantee we at least log why before exit.

process.on("unhandledRejection", (reason) => {
  log("error", "unhandled promise rejection", { reason: String(reason) });
});

process.on("uncaughtException", (error) => {
  log("error", "uncaught exception — exiting", { error: error.message, stack: error.stack });
  process.exit(1);
});

// -------------------------
// Graceful shutdown
// -------------------------
// ECS sends SIGTERM before killing a task during deploys, scale-in, or
// spot interruption, then waits `stopTimeout` seconds. This drains
// in-flight requests and closes the pool cleanly instead of dropping
// connections mid-query.

let server;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log("info", "shutdown signal received", { signal });

  const forceExitTimer = setTimeout(() => {
    log("error", "graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 10_000);

  if (server) {
    server.close(async () => {
      try {
        await pool.end();
        log("info", "MySQL pool closed cleanly");
      } catch (error) {
        log("error", "error closing MySQL pool", { error: error.message });
      } finally {
        clearTimeout(forceExitTimer);
        process.exit(0);
      }
    });
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// -------------------------
// Start Application
// -------------------------

function printBanner() {
  console.log(`
  ┌─────────────────────────────────────────┐
  │   ShopSphere backend                     │
  │   env: ${(process.env.NODE_ENV || "development").padEnd(35)}│
  │   port: ${String(PORT).padEnd(34)}│
  └─────────────────────────────────────────┘
  `);
}

async function startServer() {
  printBanner();

  try {
    await initializeDatabase();
    isReady = true;

    server = app.listen(PORT, "0.0.0.0", () => {
      log("info", "server listening", { port: PORT });
    });
  } catch (error) {
    log("error", "application startup failed", { error: error.message });
    process.exit(1);
  }
}

startServer();