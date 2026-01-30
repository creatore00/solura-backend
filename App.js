import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import { pool } from "./config/db.js"; // only for login users table
import { getPool } from "./config/dbManager.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Solura backend is running" });
});

// Login
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ success: false, message: "Email and password required" });

  try {
    const trimmedEmail = email.trim();
    const [rows] = await pool.query(
      "SELECT Email, Password, Access, db_name FROM users WHERE Email = ?",
      [trimmedEmail]
    );

    if (!rows || rows.length === 0)
      return res.json({ success: false, message: "Invalid email or password" });

    const databases = [];
    let loginSuccess = false;

    for (const row of rows) {
      const match = await bcrypt.compare(password, row.Password);
      if (match) {
        loginSuccess = true;
        databases.push({ db_name: row.db_name, access: row.Access });
      }
    }

    if (!loginSuccess) return res.json({ success: false, message: "Invalid email or password" });
    if (databases.length === 0) return res.json({ success: false, message: "No databases available" });

    return res.json({ success: true, message: "Login successful", email: trimmedEmail, databases });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Switch database endpoint
app.post("/select-database", async (req, res) => {
  const { db_name } = req.body;
  if (!db_name) return res.status(400).json({ success: false, message: "Database required" });

  try {
    const pool = getPool(db_name);
    await pool.query("SELECT 1"); // test connection
    return res.json({ success: true, message: `Connected to ${db_name}` });
  } catch (err) {
    console.error("Database selection error:", err);
    return res.status(500).json({ success: false, message: "Cannot connect to database" });
  }
});

// Get employee info by email
app.get("/employee", async (req, res) => {
  const { email, db } = req.query;
  if (!email || !db) return res.status(400).json({ success: false, message: "Email and db required" });

  try {
    const pool = getPool(db); // get the selected database connection
    const [rows] = await pool.query(
      "SELECT name, lastName FROM Employees WHERE email = ?",
      [email]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    const employee = rows[0];
    return res.json({ success: true, name: employee.name, lastName: employee.lastName });
  } catch (err) {
    console.error("Error fetching employee:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Get current week's rota by employee name + lastName
app.get("/rota", async (req, res) => {
  const { db, name, lastName } = req.query;
  if (!db || !name || !lastName)
    return res.status(400).json({ success: false, message: "Database, name, and lastName required" });

  try {
    const pool = getPool(db);

    // MySQL: STR_TO_DATE(day, '%d/%m/%Y') converts dd/mm/yyyy to DATE
    // WEEKDAY() gives 0=Monday ... 6=Sunday
    // CURDATE() is today
    // Compute Monday and Sunday of current week
    const query = `
      SELECT name, lastName, day, startTime, endTime
      FROM rota
      WHERE name = ? AND lastName = ?
        AND STR_TO_DATE(day, '%d/%m/%Y') BETWEEN
            DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)
            AND DATE_ADD(DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY), INTERVAL 6 DAY)
      ORDER BY STR_TO_DATE(day, '%d/%m/%Y')
    `;

    const [rows] = await pool.query(query, [name, lastName]);

    return res.json(rows);
  } catch (err) {
    console.error("Error fetching current week rota:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Get confirmed rota with optional month/year filter
app.get("/confirmedRota", async (req, res) => {
  const { db, name, lastName, month, year } = req.query;

  if (!db || !name || !lastName)
    return res.status(400).json({ success: false, message: "Database, name, and lastName required" });

  try {
    const pool = getPool(db); // get selected database pool

    let query = `
      SELECT name, lastName, day, startTime, endTime
      FROM ConfirmedRota
      WHERE name = ? AND lastName = ?
    `;
    const params = [name, lastName];

    if (month && year) {
      query += `
        AND MONTH(STR_TO_DATE(day, '%d/%m/%Y')) = ?
        AND YEAR(STR_TO_DATE(day, '%d/%m/%Y')) = ?
      `;
      params.push(parseInt(month), parseInt(year));
    }

    query += ` ORDER BY STR_TO_DATE(day, '%d/%m/%Y')`;

    const [rows] = await pool.query(query, params);

    return res.json(rows);
  } catch (err) {
    console.error("Error fetching confirmed rota:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});


const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
