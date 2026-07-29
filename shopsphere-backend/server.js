const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

// -------------------------
// MySQL Connection Pool
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

async function initializeDatabase() {
  console.log("Connecting to MySQL...");

  // Test database connection
  const connection = await pool.getConnection();

  console.log("Connected to MySQL successfully");

  connection.release();

  // Create products table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      price DECIMAL(10,2) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("Products table ready");

  // Check whether seed data already exists
  const [rows] = await pool.query(
    "SELECT COUNT(*) AS count FROM products"
  );

  // Seed only when table is empty
  if (rows[0].count === 0) {
    await pool.query(`
      INSERT INTO products (name, price)
      VALUES
        ('Laptop', 55555.00),
        ('Headphones', 495555599.00),
        ('Keyboard', 55555.00)
    `);

    console.log("Initial products inserted");
  } else {
    console.log("Products already exist — skipping seed");
  }
}

// -------------------------
// Health Check
// -------------------------

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "UP",
    service: "shopsphere-backend"
  });
});

// -------------------------
// Products API
// -------------------------

app.get("/api/products", async (req, res) => {
  console.log("GET /api/products received");

  try {
    console.log("DB_HOST:", process.env.DB_HOST);
    console.log("DB_NAME:", process.env.DB_NAME);
    console.log("DB_USERNAME exists:", !!process.env.DB_USERNAME);
    console.log("DB_PASSWORD exists:", !!process.env.DB_PASSWORD);

    const [products] = await pool.query(
      "SELECT id, name, price FROM products ORDER BY id"
    );

    console.log("Products retrieved:", products.length);

    res.status(200).json(products);

  } catch (error) {
    console.error("DATABASE ERROR:", error);

    res.status(500).json({
      error: "Unable to retrieve products",
      dbError: error.message // TEMPORARY debugging only
    });
  }
});

// -------------------------
// Start Application
// -------------------------

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`ShopSphere backend running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Application startup failed");
    console.error(error);

    process.exit(1);
  }
}

startServer();