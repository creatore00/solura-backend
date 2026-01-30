import express from "express";
import mysql from "mysql2/promise";
import cors from "cors";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import { pool } from "./config/db.js";  // <- use our new config

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Solura backend is running",
  });
});

// Login endpoint
app.post("/login", async (req, res) => {
  console.log("Login request received");

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      message: "Email and password required",
    });
  }

  try {
    const trimmedEmail = email.trim();

    // Query database for user rows
    const [rows] = await pool.query(
      "SELECT Email, Password, Access, db_name FROM users WHERE Email = ?",
      [trimmedEmail]
    );

    if (!rows || rows.length === 0) {
      return res.json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const databases = [];
    let loginSuccess = false;

    // Check password match for any row
    for (const row of rows) {
      const match = await bcrypt.compare(password, row.Password);

      if (match) {
        loginSuccess = true;
        databases.push({
          db_name: row.db_name || "",
          access: row.Access || "read",
        });
      }
    }

    if (!loginSuccess) {
      return res.json({
        success: false,
        message: "Invalid email or password",
      });
    }

    if (databases.length === 0) {
      return res.json({
        success: false,
        message: "No databases available",
      });
    }

    return res.json({
      success: true,
      message: "Login successful",
      email: trimmedEmail,
      databases,
    });
  } catch (err) {
    console.error("Server error during login:", err);
    return res.status(500).json({
      success: false,
      message: "Server error. Please try again.",
    });
  }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
