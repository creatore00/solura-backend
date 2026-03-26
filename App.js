import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import { pool } from "./config/db.js"; // only for login users table
import { getPool } from "./config/dbManager.js";
import fs from 'fs';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increased limit for image uploads
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Add this at the top of your backend file:
import admin from 'firebase-admin';
// Initialize Firebase Admin from environment variable
let firebaseInitialized = false;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    firebaseInitialized = true;
    console.log('✅ Firebase Admin initialized from environment variable');
  } else {
    console.log('⚠️ FIREBASE_SERVICE_ACCOUNT environment variable not set');
  }
} catch (error) {
  console.error('❌ Error initializing Firebase Admin:', error.message);
}

// ==================== HELPER FUNCTIONS ====================

// Helper function to generate unique 16-digit code
function generateUniqueCode() {
  // Generate 16-digit number
  const min = 1000000000000000; // 10^15
  const max = 9999999999999999; // 10^16 - 1
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ✅ checks BOTH ShiftRequests + rota for collisions
async function generateUniqueShiftId(conn) {
  while (true) {
    const id = generateUniqueCode();

    const [a] = await conn.query(`SELECT id FROM ShiftRequests WHERE id = ? LIMIT 1`, [id]);
    if (a && a.length > 0) continue;

    const [b] = await conn.query(`SELECT id FROM rota WHERE id = ? LIMIT 1`, [id]);
    if (b && b.length > 0) continue;

    return id;
  }
}

function toHHMMSS(input) {
  // Accept "HH:mm" or "HH:mm:ss" -> return "HH:mm:ss"
  const s = String(input || "").trim();
  if (/^\d{2}:\d{2}:\d{2}$/.test(s)) return s;
  if (/^\d{2}:\d{2}$/.test(s)) return `${s}:00`;
  return null;
}

function formatDayLabel(dateStr) {
  // dateStr expected "YYYY-MM-DD"
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;

  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();

  const weekday = d.toLocaleDateString("en-GB", { weekday: "long" });
  return `${dd}/${mm}/${yyyy} (${weekday})`;
}

// Helper function to ensure time has seconds
function ensureTimeWithSeconds(time) {
  if (!time) return '00:00:00';
  if (time.includes(':')) {
    const parts = time.split(':');
    if (parts.length === 2) {
      return time + ':00'; // Add seconds if missing
    }
  }
  return time;
}

async function getUserAccessFromMainDB({ authPool, email, db }) {
  const e = String(email).trim().toLowerCase();

  const [rows] = await authPool.query(
    `SELECT TRIM(LOWER(COALESCE(\`Access\`, ''))) AS access
     FROM users
     WHERE (LOWER(TRIM(\`Email\`)) = ? OR LOWER(TRIM(email)) = ?)
       AND TRIM(LOWER(db_name)) = TRIM(LOWER(?))
     LIMIT 1`,
    [e, e, db]
  );

  if (!rows || rows.length === 0) return { found: false, access: "" };
  return { found: true, access: rows[0].access || "" };
}

// Helper function to generate unique post ID
function generatePostId() {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 10000);
  return `post_${timestamp}_${random}`;
}

// Helper function to format date with day
function formatDateWithDay(dateString) {
  if (!dateString) return "";

  try {
    const str = String(dateString).trim();

    // Case 1: already "dd/mm/yyyy (Day)"
    const alreadyWithDay = /^(\d{2})\/(\d{2})\/(\d{4})\s*\([A-Za-z]+\)$/;
    if (alreadyWithDay.test(str)) return str;

    // Case 2: "dd/mm/yyyy" -> add day
    const ddmmyyyy = /^(\d{2})\/(\d{2})\/(\d{4})$/;
    const match = str.match(ddmmyyyy);
    if (match) {
      const day = parseInt(match[1], 10);
      const month = parseInt(match[2], 10);
      const year = parseInt(match[3], 10);

      // Create date in a stable way (avoid timezone shifts):
      const d = new Date(Date.UTC(year, month - 1, day));
      const weekday = new Intl.DateTimeFormat("en-GB", {
        weekday: "long",
        timeZone: "UTC",
      }).format(d);

      return `${match[1]}/${match[2]}/${match[3]} (${weekday})`;
    }

    // Case 3: ISO / Date / yyyy-mm-dd etc.
    const parsed = new Date(str);
    if (isNaN(parsed.getTime())) return str;

    // Force UTC date parts to avoid “day changes” due to server timezone
    const yyyy = parsed.getUTCFullYear();
    const mm = String(parsed.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(parsed.getUTCDate()).padStart(2, "0");

    const weekday = new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(yyyy, parsed.getUTCMonth(), parsed.getUTCDate())));

    return `${dd}/${mm}/${yyyy} (${weekday})`;
  } catch (err) {
    console.error("Error formatting date with day:", err);
    return String(dateString);
  }
}

// Helper function to format dates
function formatDate(dateString) {
  if (!dateString) return '';
  
  try {
    // If date is already in dd/mm/yyyy format, return as is
    if (dateString.includes('/')) {
      return dateString;
    }
    
    // If it's a Date object or ISO string
    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
      return dateString; // Return original if can't parse
    }
    
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    
    return `${day}/${month}/${year}`;
  } catch (error) {
    console.error("Error formatting date:", error);
    return dateString;
  }
}

// ==================== SHIFTS REQUESTS ====================

app.post("/rota/shift-request", async (req, res) => {
  const { db, userEmail, dayDate, startTime, endTime, neededFor } = req.body;

  if (!db || !userEmail || !dayDate || !startTime || !endTime) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  const authPool = pool;                // ✅ MAIN DB (yassir_access)
  const workspacePool = getPool(db);    // ✅ WORKSPACE DB
  const conn = await workspacePool.getConnection();

  try {
    const accessInfo = await getUserAccessFromMainDB({ authPool, email: userEmail, db });

    console.log("🔎 CREATE SHIFT CHECK:", { db, userEmail, accessInfo });

    if (!accessInfo.found) {
      conn.release();
      return res.status(403).json({ success: false, message: "User not found for workspace" });
    }

    const access = accessInfo.access; // already lower-case
    const canCreate = ["admin", "am", "assistant manager"].includes(access);

    if (!canCreate) {
      conn.release();
      return res.status(403).json({
        success: false,
        message: `Not allowed to create shift. Access='${access}'`,
      });
    }

    // normalize HH:mm -> HH:mm:ss
    const toHHMMSS = (s) => {
      s = String(s || "").trim();
      if (/^\d{2}:\d{2}:\d{2}$/.test(s)) return s;
      if (/^\d{2}:\d{2}$/.test(s)) return `${s}:00`;
      return null;
    };

    const st = toHHMMSS(startTime);
    const et = toHHMMSS(endTime);
    if (!st || !et) {
      conn.release();
      return res.status(400).json({ success: false, message: "Times must be HH:mm or HH:mm:ss" });
    }

    // day label "dd/mm/yyyy (Day)"
    const formatDayLabel = (dateStr) => {
      const d = new Date(`${dateStr}T00:00:00`);
      if (Number.isNaN(d.getTime())) return null;
      const dd = String(d.getDate()).padStart(2, "0");
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const yyyy = d.getFullYear();
      const weekday = d.toLocaleDateString("en-GB", { weekday: "long" });
      return `${dd}/${mm}/${yyyy} (${weekday})`;
    };

    const dayLabel = formatDayLabel(dayDate);
    if (!dayLabel) {
      conn.release();
      return res.status(400).json({ success: false, message: "dayDate must be YYYY-MM-DD" });
    }

    const needed = ["foh", "boh", "anyone"].includes(String(neededFor).toLowerCase())
      ? String(neededFor).toLowerCase()
      : "anyone";

    const id = await generateUniqueShiftId(conn);

    await conn.query(
      `INSERT INTO ShiftRequests
       (id, day_date, day_label, start_time, end_time, needed_for, status, created_by_email)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [id, dayDate, dayLabel, st, et, needed, String(userEmail).trim().toLowerCase()]
    );

    conn.release();

    console.log(`✅ Shift request created | db=${db} | id=${id} | by=${userEmail} | access=${access}`);

    return res.json({ success: true, message: "Shift request created", id });
  } catch (err) {
    conn.release();
    console.error("❌ Error creating shift request:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

app.get("/rota/shift-requests", async (req, res) => {
  const { db } = req.query;

  if (!db) {
    return res.status(400).json({ success: false, message: "db is required" });
  }

  try {
    const workspacePool = getPool(db);

    const [rows] = await workspacePool.query(
      `SELECT id, day_date, day_label, start_time, end_time, needed_for, status,
              created_by_email, created_at,
              accepted_by_email, accepted_first_name, accepted_last_name, accepted_at
       FROM ShiftRequests
       WHERE status IN ('pending','accepted')
       ORDER BY
         (status='pending') DESC,
         day_date ASC,
         start_time ASC`
    );

    return res.json({ success: true, shifts: rows });
  } catch (err) {
    console.error("❌ Error fetching shift requests:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

app.post("/rota/shift-request/:id/accept", async (req, res) => {
  const { db, userEmail } = req.body;
  const { id } = req.params;

  if (!db || !id || !userEmail) {
    return res.status(400).json({
      success: false,
      message: "db, id, userEmail are required",
    });
  }

  const email = String(userEmail).trim().toLowerCase();
  const workspacePool = getPool(db);
  const conn = await workspacePool.getConnection();

  try {
    await conn.beginTransaction();

    // 1) Lock the shift request
    const [reqRows] = await conn.query(
      `SELECT id, day_label, start_time, end_time, needed_for, status
       FROM ShiftRequests
       WHERE id = ?
       FOR UPDATE`,
      [id]
    );

    if (!reqRows || reqRows.length === 0) {
      await conn.rollback();
      conn.release();
      return res.status(404).json({ success: false, message: "Shift request not found" });
    }

    const shift = reqRows[0];

    if (shift.status !== "pending") {
      await conn.rollback();
      conn.release();
      return res.status(409).json({ success: false, message: "Shift already accepted/cancelled" });
    }

    // 2) Get employee data from WORKSPACE DB
    const [empRows] = await conn.query(
      `SELECT 
         TRIM(COALESCE(name,''))     AS name,
         TRIM(COALESCE(lastName,'')) AS lastName,
         TRIM(UPPER(COALESCE(designation,''))) AS designation
       FROM Employees
       WHERE LOWER(TRIM(email)) = ? OR LOWER(TRIM(\`Email\`)) = ?
       LIMIT 1`,
      [email, email]
    );

    console.log("🔎 ACCEPT SHIFT EMP CHECK:", { db, id, email, emp: empRows?.[0] || null });

    if (!empRows || empRows.length === 0) {
      await conn.rollback();
      conn.release();
      return res.status(403).json({
        success: false,
        message: "Employee not found in this workspace",
      });
    }

    const emp = empRows[0];
    const empDesignation = String(emp.designation || "").trim().toUpperCase(); // FOH/BOH/AM/ADMIN...

    // 3) Eligibility
    const neededFor = String(shift.needed_for || "anyone").toLowerCase();

    const eligible =
      neededFor === "anyone" ||
      (neededFor === "foh" && empDesignation === "FOH") ||
      (neededFor === "boh" && empDesignation === "BOH");

    if (!eligible) {
      await conn.rollback();
      conn.release();
      return res.status(403).json({
        success: false,
        message: `Not eligible. neededFor='${neededFor}', designation='${empDesignation}'`,
      });
    }

    // 4) Safety: rota id collision check
    const [rotaExists] = await conn.query(`SELECT id FROM rota WHERE id = ? LIMIT 1`, [id]);
    if (rotaExists && rotaExists.length > 0) {
      await conn.rollback();
      conn.release();
      return res.status(409).json({
        success: false,
        message: `Shift id already exists in rota. id='${id}'`,
      });
    }

    // 5) Mark request accepted
    await conn.query(
      `UPDATE ShiftRequests
       SET status='accepted',
           accepted_by_email=?,
           accepted_first_name=?,
           accepted_last_name=?,
           accepted_at=NOW()
       WHERE id=?`,
      [email, emp.name, emp.lastName, id]
    );

    // 6) Insert into rota (YOUR columns)
    await conn.query(
      `INSERT INTO rota
       (id, name, lastName, day, startTime, endTime, designation)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, emp.name, emp.lastName, shift.day_label, shift.start_time, shift.end_time, empDesignation]
    );

    await conn.commit();
    conn.release();

    console.log(`✅ Shift accepted + inserted into rota | db=${db} | id=${id} | by=${email} | ${emp.name} ${emp.lastName} | ${empDesignation}`);

    return res.json({ success: true, message: "Shift accepted", id });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    conn.release();
    console.error("❌ Error accepting shift:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// GET /rota/my-day?db=WORKSPACE&email=user@email.com&date=YYYY-MM-DD
app.get("/rota/my-day", async (req, res) => {
  const { db, email, date } = req.query;

  if (!db || !email || !date) {
    return res.status(400).json({
      success: false,
      message: "db, email, date are required",
    });
  }

  const workspacePool = getPool(db);
  const conn = await workspacePool.getConnection();

  try {
    // 1) get employee name/lastName/designation from Employees table in workspace DB
    const userEmail = String(email).trim().toLowerCase();

    const [empRows] = await conn.query(
      `SELECT name, lastName, designation
       FROM Employees
       WHERE LOWER(TRIM(email)) = ?
       LIMIT 1`,
      [userEmail]
    );

    if (!empRows || empRows.length === 0) {
      conn.release();
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    const emp = empRows[0];

    // 2) convert YYYY-MM-DD -> dd/MM/yyyy
    const [yyyy, mm, dd] = String(date).split("-");
    const dayPrefix = `${dd}/${mm}/${yyyy}`; // dd/MM/yyyy

    // 3) fetch rota entries for that day for that employee
    const [rotaRows] = await conn.query(
      `SELECT id, day, startTime, endTime, designation
       FROM rota
       WHERE TRIM(name) = TRIM(?)
         AND TRIM(lastName) = TRIM(?)
         AND day LIKE CONCAT(?, '%')`,
      [emp.name, emp.lastName, dayPrefix]
    );

    conn.release();

    return res.json({
      success: true,
      shifts: rotaRows || [],
      employee: {
        name: emp.name,
        lastName: emp.lastName,
        designation: emp.designation,
      },
    });
  } catch (err) {
    conn.release();
    console.error("❌ /rota/my-day error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
});

// Get all employees
app.get("/rota/employees", async (req, res) => {
  const { db } = req.query;
  
  if (!db) {
    return res.status(400).json({ success: false, message: "db required" });
  }
  
  try {
    const pool = getPool(db);
    const [rows] = await pool.query(
      `SELECT id, name, lastName, email, designation FROM Employees WHERE situation IS NULL
      OR TRIM(situation) = '' ORDER BY name`
    );
    
    res.json({ success: true, employees: rows });
  } catch (err) {
    console.error("Error fetching employees:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ENDPOINT: Aggiungi turno direttamente in rota
app.post("/rota/add-direct", async (req, res) => {
  try {
    const { 
      db, 
      userEmail, 
      dayLabel,  // Questo dovrebbe già arrivare nel formato corretto
      dayDate, 
      startTime, 
      endTime, 
      employeeEmail,
      employeeName,
      employeeLastName,
      employeeDesignation 
    } = req.body;

    console.log("=================================");
    console.log("📝 ADD TO ROTA DIRECTLY");
    console.log("=================================");
    console.log("db:", db);
    console.log("userEmail:", userEmail);
    console.log("dayLabel:", dayLabel); // Es: "13/03/2026 (Friday)"
    console.log("dayDate:", dayDate);    // Es: "2026-03-13"
    console.log("startTime:", startTime);
    console.log("endTime:", endTime);
    console.log("employeeEmail:", employeeEmail);
    console.log("=================================");

    if (!db || !dayLabel || !startTime || !endTime || !employeeEmail) {
      return res.status(400).json({ 
        success: false, 
        message: "Missing required fields" 
      });
    }

    const pool = getPool(db);
    
    // Genera un ID univoco per il turno
    const shiftId = Math.floor(1000000000000000 + Math.random() * 9000000000000000).toString();
    
    // Inserisci nella tabella rota - usa dayLabel che ha già il formato corretto
    const [result] = await pool.query(
      `INSERT INTO rota 
       (id, name, lastName, day, startTime, endTime, designation) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        shiftId,
        employeeName,
        employeeLastName,
        dayLabel,  // Già nel formato "dd/mm/yyyy (Monday)"
        startTime,
        endTime,
        employeeDesignation
      ]
    );

    console.log(`✅ Shift added to rota with ID: ${shiftId}`);
    console.log(`✅ Day format: ${dayLabel}`);

    res.json({ 
      success: true, 
      message: "Shift added to rota successfully",
      shiftId: shiftId 
    });

  } catch (err) {
    console.error("❌ Error adding to rota:", err);
    res.status(500).json({ 
      success: false, 
      message: "Server error",
      error: err.message 
    });
  }
});

// ==================== PAYSLIPS ENDPOINTS ====================

// Get payslips for logged-in employee with pagination and month filter
app.get("/employee/payslips", async (req, res) => {
  const { db, email, month, page = 1, limit = 10 } = req.query;

  console.log("=================================");
  console.log("📊 GET PAYSLIPS - Request received");
  console.log("=================================");
  console.log("db:", db);
  console.log("email:", email);
  console.log("month:", month);
  console.log("page:", page);
  console.log("limit:", limit);
  console.log("=================================");

  if (!db || !email) {
    console.log("❌ Missing db or email");
    return res.status(400).json({ 
      success: false, 
      message: "Database and email are required" 
    });
  }

  try {
    const pool = getPool(db);
    console.log("✅ Got pool for database:", db);
    
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    // Build query conditions
    let whereConditions = ["email = ?"];
    let queryParams = [email];
    
    if (month) {
      whereConditions.push("Month = ?");
      queryParams.push(month);
    }
    
    const whereClause = whereConditions.join(" AND ");
    
    // Get total count for pagination
    const countQuery = `SELECT COUNT(*) as total FROM payslips WHERE ${whereClause}`;
    console.log("📊 Count query:", countQuery);
    console.log("📊 Count params:", queryParams);
    
    const [countResult] = await pool.query(countQuery, queryParams);
    console.log("✅ Count result:", countResult);
    
    const total = countResult[0]?.total || 0;
    console.log(`📊 Total payslips found: ${total}`);
    
    if (total === 0) {
      return res.json({
        success: true,
        payslips: [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: 0,
          totalPages: 0,
          hasMore: false
        }
      });
    }
    
    // Get payslips with pagination
    const dataQuery = `
      SELECT 
        id, 
        name, 
        lastName, 
        email, 
        Month, 
        payslip_number, 
        date
      FROM payslips 
      WHERE ${whereClause}
      ORDER BY STR_TO_DATE(CONCAT(Month, '-01'), '%Y-%m-%d') DESC, 
               payslip_number ASC,
               date DESC
      LIMIT ? OFFSET ?
    `;
    
    const dataParams = [...queryParams, parseInt(limit), offset];
    console.log("📊 Data query:", dataQuery);
    console.log("📊 Data params:", dataParams);
    
    const [rows] = await pool.query(dataQuery, dataParams);
    console.log(`✅ Found ${rows.length} payslips`);
    
    // Format the response
    const payslips = rows.map(row => ({
      id: row.id,
      name: row.name,
      lastName: row.lastName,
      email: row.email,
      month: row.Month,
      payslipNumber: row.payslip_number,
      uploadDate: row.date,
      monthDisplay: formatMonthDisplay(row.Month)
    }));
    
    console.log("📊 Sending response with", payslips.length, "payslips");
    
    res.json({
      success: true,
      payslips: payslips,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: total,
        totalPages: Math.ceil(total / parseInt(limit)),
        hasMore: offset + payslips.length < total
      }
    });
    
  } catch (error) {
    console.error("❌ Exception in /employee/payslips:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error",
      error: error.message 
    });
  }
});

// Get months with available payslips for dropdown
app.get("/employee/payslip-months", async (req, res) => {
  const { db, email } = req.query;

  console.log("=================================");
  console.log("📊 GET MONTHS - Request received");
  console.log("=================================");
  console.log("db:", db);
  console.log("email:", email);
  console.log("=================================");

  if (!db || !email) {
    console.log("❌ Missing db or email");
    return res.status(400).json({ 
      success: false, 
      message: "Database and email are required" 
    });
  }

  try {
    const pool = getPool(db);
    console.log("✅ Got pool for database:", db);
    
    const query = `
      SELECT DISTINCT Month 
      FROM payslips 
      WHERE email = ? 
      ORDER BY STR_TO_DATE(CONCAT(Month, '-01'), '%Y-%m-%d') DESC
    `;
    console.log("📊 Query:", query);
    console.log("📊 Email param:", email);
    
    const [rows] = await pool.query(query, [email]);
    console.log(`✅ Found ${rows.length} months`);
    console.log("📊 Months data:", rows);
    
    const months = rows.map(row => ({
      value: row.Month,
      display: formatMonthDisplay(row.Month)
    }));
    
    res.json({
      success: true,
      months: months
    });
    
  } catch (error) {
    console.error("❌ Exception in /employee/payslip-months:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error",
      error: error.message 
    });
  }
});

// Helper function to format month display
function formatMonthDisplay(monthYear) {
  if (!monthYear) return '';
  const [year, month] = monthYear.split('-');
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  return `${monthNames[parseInt(month) - 1]} ${year}`;
}

// Download payslip for employee
app.get("/employee/download-payslip/:id", async (req, res) => {
  const { db, email } = req.query;
  const { id } = req.params;

  console.log("=================================");
  console.log("📥 DOWNLOAD PAYSLIP - Request received");
  console.log("=================================");
  console.log("db:", db);
  console.log("email:", email);
  console.log("id:", id);
  console.log("=================================");

  if (!db || !email || !id) {
    console.log("❌ Missing db, email, or id");
    return res.status(400).json({ 
      success: false, 
      message: "Database, email, and payslip ID are required" 
    });
  }

  try {
    const pool = getPool(db);
    console.log("✅ Got pool for database:", db);
    
    const query = 'SELECT fileContent, name, lastName, Month, payslip_number FROM payslips WHERE id = ? AND email = ?';
    console.log("📊 Query:", query);
    console.log("📊 Params:", [id, email]);
    
    const [rows] = await pool.query(query, [id, email]);
    console.log(`✅ Query result rows: ${rows ? rows.length : 0}`);
    
    if (!rows || rows.length === 0) {
      console.log("❌ No payslip found or unauthorized");
      return res.status(404).json({ success: false, message: 'Payslip not found or unauthorized' });
    }
    
    const payslip = rows[0];
    const buffer = payslip.fileContent;
    
    if (!buffer || buffer.length === 0) {
      console.log("❌ File content is empty");
      return res.status(404).json({ success: false, message: 'File content is empty' });
    }
    
    console.log(`✅ File content size: ${buffer.length} bytes`);
    
    // Detect file type from content
    let fileType = 'application/octet-stream';
    let fileExt = 'bin';
    
    const header = buffer.toString('ascii', 0, 4);
    if (header === '%PDF') {
      fileType = 'application/pdf';
      fileExt = 'pdf';
      console.log("📄 Detected PDF file");
    } else if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
      fileType = 'image/jpeg';
      fileExt = 'jpg';
      console.log("🖼️ Detected JPEG image");
    } else if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      fileType = 'image/png';
      fileExt = 'png';
      console.log("🖼️ Detected PNG image");
    }
    
    const fileName = `earnings_${payslip.name}_${payslip.lastName}_${payslip.Month}_${payslip.payslip_number}.${fileExt}`;
    console.log(`📁 Filename: ${fileName}`);
    
    res.setHeader('Content-Type', fileType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);
    console.log("✅ File sent successfully");
    
  } catch (error) {
    console.error("❌ Exception in download-payslip:", error);
    res.status(500).json({ success: false, message: 'Server error: ' + error.message });
  }
});

// ==================== FEED ENDPOINTS ====================

// Create a new feed post
app.post("/feed/create", async (req, res) => {
  const { 
    db, 
    authorEmail, 
    content, 
    attachments, 
    visibility = 'all', 
    mentions = [], 
    bulkMentions = [], 
    poll 
  } = req.body;

  if (!db || !authorEmail || !content) {
    return res.status(400).json({
      success: false,
      message: "Database, author email, and content are required"
    });
  }

  try {
    const pool = getPool(db);

    // Get author info from Employees table
    const [authorRows] = await pool.query(
      "SELECT name, lastName, designation FROM Employees WHERE email = ?",
      [authorEmail]
    );

    if (!authorRows || authorRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Author not found"
      });
    }

    const author = authorRows[0];
    const authorName = `${author.name} ${author.lastName}`;
    const postId = generatePostId();
    const createdAt = new Date();
    
    const visibilityStr = Array.isArray(visibility) ? visibility.join(',') : visibility;

    // ===========================================
    // 1. INSERT POST INTO FeedPosts
    // ===========================================
    await pool.query(
      `INSERT INTO FeedPosts (
        id, authorName, authorEmail, authorDesignation, content, 
        attachments, visibility, createdAt, expiresAt, isPinned, isActive
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        postId, 
        authorName, 
        authorEmail, 
        author.designation || '',
        content, 
        attachments && attachments.length > 0 ? JSON.stringify(attachments) : null,
        visibilityStr, 
        createdAt, 
        null, 
        false, 
        true
      ]
    );

    // ===========================================
    // 2. INSERT POLL IF EXISTS
    // ===========================================
    if (poll) {
      try {
        const pollId = generatePostId();
        await pool.query(
          `INSERT INTO FeedPolls (id, postId, question, multipleChoice, endsAt, createdAt)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            pollId,
            postId,
            poll.question,
            poll.multipleChoice || false,
            poll.endsAt || null,
            new Date()
          ]
        );

        // Insert poll options
        for (const optionText of poll.options) {
          const optionId = generatePostId();
          await pool.query(
            `INSERT INTO FeedPollOptions (id, pollId, optionText, votes)
             VALUES (?, ?, ?, 0)`,
            [optionId, pollId, optionText]
          );
        }
        
        console.log(`✅ Poll created: ${pollId}`);
      } catch (pollError) {
        console.error("❌ Error creating poll:", pollError);
      }
    }

    // ===========================================
    // 3. INSERT MEDIA IF EXISTS - FIXED VERSION
    // ===========================================
    if (attachments && attachments.length > 0) {
      for (const attachment of attachments) {
        try {
          const mediaId = generatePostId();
          let url = null;
          
          // Handle image data
          if (attachment.type === 'image' && attachment.data) {
            // For development: create data URL
            url = `data:image/jpeg;base64,${attachment.data}`;
            
            // For production: you would upload to cloud storage here
            // const cloudinaryUrl = await uploadToCloudinary(attachment.data);
            // url = cloudinaryUrl;
          }
          
          await pool.query(
            `INSERT INTO FeedMedia (id, postId, type, url, filename, filesize, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              mediaId,
              postId,
              attachment.type || 'file',
              url,
              attachment.name || null,
              attachment.size || 0,
              new Date()
            ]
          );
          
          console.log(`✅ Media saved: ${attachment.type} - ${url ? 'URL generated' : 'no URL'}`);
        } catch (mediaError) {
          console.error("❌ Error inserting media:", mediaError);
        }
      }
    }

    // Set per tracciare utenti già notificati (evita duplicati)
    const notifiedUsers = new Set();
    const mentionDetails = [];
    
    // ===========================================
    // 4. PROCESS REGULAR MENTIONS
    // ===========================================
    if (mentions && mentions.length > 0) {
      for (const mention of mentions) {
        const cleanMention = mention.replace('@', '').trim();
        
        if (cleanMention.length < 2) continue;

        const [mentionedRows] = await pool.query(
          `SELECT email, name, lastName, designation 
           FROM Employees 
           WHERE CONCAT(name, ' ', lastName) = ? 
              OR CONCAT(name, lastName) = ?
              OR email = ?
              OR email LIKE ?
              OR name LIKE ?
              OR lastName LIKE ?
           LIMIT 1`,
          [
            cleanMention, 
            cleanMention.replace(' ', ''), 
            cleanMention,
            `%${cleanMention}%`,
            `%${cleanMention}%`,
            `%${cleanMention}%`
          ]
        );

        for (const mentionedUser of mentionedRows) {
          if (mentionedUser.email !== authorEmail && !notifiedUsers.has(mentionedUser.email)) {
            notifiedUsers.add(mentionedUser.email);
            
            // Send mention notification
            try {
              await pool.query(
                `INSERT INTO Notifications 
                 (targetRole, targetEmail, authorEmail, title, message, type, postId, isRead, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  'USER', 
                  mentionedUser.email,
                  authorEmail,
                  '📢 You were mentioned in a post',
                  `${authorName} mentioned you: "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`,
                  'MENTION',
                  postId,
                  false,
                  new Date()
                ]
              );
              console.log(`✅ Mention notification sent to: ${mentionedUser.email}`);
            } catch (notifError) {
              console.error("❌ Error inserting mention notification:", notifError);
            }

            // Store mention in FeedPostMentions
            try {
              const mentionId = generatePostId();
              await pool.query(
                `INSERT INTO FeedPostMentions (id, postId, mentionedEmail, mentionedName, createdAt)
                 VALUES (?, ?, ?, ?, ?)`,
                [
                  mentionId,
                  postId,
                  mentionedUser.email,
                  `${mentionedUser.name} ${mentionedUser.lastName}`,
                  new Date()
                ]
              );
              
              mentionDetails.push({
                email: mentionedUser.email,
                name: `${mentionedUser.name} ${mentionedUser.lastName}`
              });
              
              console.log(`✅ Mention stored for: ${mentionedUser.email}`);
            } catch (mentionError) {
              console.error("❌ Error storing mention:", mentionError);
            }
          }
        }
      }
    }

    // ===========================================
    // 5. PROCESS BULK MENTIONS (FOH, BOH, EVERYONE)
    // ===========================================
    if (bulkMentions && bulkMentions.length > 0) {
      for (const bulk of bulkMentions) {
        const cleanBulk = bulk.replace('@', '').trim().toUpperCase();
        
        let targetEmployees = [];
        
        if (cleanBulk === 'FOH' || cleanBulk === 'BOH') {
          // Get all employees with this designation
          const [rows] = await pool.query(
            `SELECT email, name, lastName FROM Employees WHERE UPPER(designation) = ?`,
            [cleanBulk]
          );
          targetEmployees = rows;
        } else if (cleanBulk === 'EVERYONE' || cleanBulk === 'ALL') {
          // Get all employees except author
          const [rows] = await pool.query(
            `SELECT email, name, lastName FROM Employees WHERE email != ?`,
            [authorEmail]
          );
          targetEmployees = rows;
        }

        // Send notifications to all target employees
        for (const emp of targetEmployees) {
          if (!notifiedUsers.has(emp.email)) {
            notifiedUsers.add(emp.email);
            
            try {
              await pool.query(
                `INSERT INTO Notifications 
                 (targetRole, targetEmail, authorEmail, title, message, type, postId, isRead, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  'USER',
                  emp.email,
                  authorEmail,
                  `📢 New post for ${cleanBulk} team`,
                  `${authorName} posted: "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`,
                  'FEED',
                  postId,
                  false,
                  new Date()
                ]
              );
            } catch (notifError) {
              console.error(`❌ Error sending bulk notification to ${emp.email}:`, notifError);
            }
          }
        }
        
        console.log(`✅ Bulk mention processed for ${cleanBulk}: ${targetEmployees.length} employees`);
      }
    }

    // ===========================================
    // 6. SEND NOTIFICATIONS TO ALL USERS
    // ===========================================
    try {
      const [allEmployees] = await pool.query(
        `SELECT email FROM Employees WHERE email != ?`,
        [authorEmail]
      );
      
      const title = "📱 New Feed Post";
      const message = `${authorName} posted: "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`;
      
      if (allEmployees.length > 0) {
        // Filter out users who already got mention notifications
        const usersToNotify = allEmployees.filter(emp => !notifiedUsers.has(emp.email));
        
        if (usersToNotify.length > 0) {
          const values = usersToNotify.map(emp => [
            'USER',
            emp.email,
            authorEmail,
            title,
            message,
            'FEED',
            postId,
            false,
            new Date()
          ]);
          
          const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
          const flatValues = values.flat();
          
          await pool.query(
            `INSERT INTO Notifications 
             (targetRole, targetEmail, authorEmail, title, message, type, postId, isRead, createdAt)
             VALUES ${placeholders}`,
            flatValues
          );
          
          console.log(`✅ Feed notifications sent to ${usersToNotify.length} users`);
        }
      }
    } catch (notifError) {
      console.error("❌ Error sending notifications to all users:", notifError);
    }

    // ===========================================
    // 7. RETURN SUCCESS RESPONSE
    // ===========================================
    
    // Get media URLs to return
    let imageUrl = null;
    let videoUrl = null;
    
    if (attachments && attachments.length > 0) {
      const imageAttachment = attachments.find(a => a.type === 'image');
      if (imageAttachment) {
        imageUrl = imageAttachment.data 
          ? `data:image/jpeg;base64,${imageAttachment.data}`
          : imageAttachment.url;
      }
      
      const videoAttachment = attachments.find(a => a.type === 'video');
      if (videoAttachment) {
        videoUrl = videoAttachment.url;
      }
    }

    return res.json({
      success: true,
      message: "Post created successfully",
      postId,
      post: {
        id: postId,
        authorName,
        authorEmail,
        authorDesignation: author.designation,
        content,
        imageUrl,
        videoUrl,
        attachments: attachments || [],
        visibility: visibilityStr,
        createdAt,
        expiresAt: null,
        isPinned: false,
        isActive: true,
        likes: 0,
        comments: 0,
        likedByUser: false,
        mentions: mentionDetails.map(m => m.name),
        bulkMentions: bulkMentions || [],
        hasPoll: !!poll
      }
    });

  } catch (err) {
    console.error("❌ Error creating feed post:", err);
    return res.status(500).json({
      success: false,
      message: "Server error creating post",
      error: err.message
    });
  }
});

// Get feed posts
app.get("/feed/posts", async (req, res) => {
  const { db, userEmail, page = 1, limit = 20, filter } = req.query;

  if (!db || !userEmail) {
    return res.status(400).json({
      success: false,
      message: "Database and user email are required"
    });
  }

  try {
    const pool = getPool(db);
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Get user info to determine their role
    const [userRows] = await pool.query(
      "SELECT designation FROM Employees WHERE email = ?",
      [userEmail]
    );

    const userDesignation = userRows[0]?.designation || 'FOH';

    // Main query to get posts
    let query = `
      SELECT 
        p.id,
        p.authorName,
        p.authorEmail,
        p.authorDesignation,
        p.content,
        p.attachments,
        p.visibility,
        p.createdAt,
        p.expiresAt,
        p.isPinned,
        p.isActive,
        COALESCE(l.likes_count, 0) as likes_count,
        COALESCE(c.comments_count, 0) as comments_count,
        CASE WHEN ul.userEmail IS NOT NULL THEN true ELSE false END as liked_by_user
      FROM FeedPosts p
      LEFT JOIN (
        SELECT postId, COUNT(*) as likes_count
        FROM FeedLikes
        GROUP BY postId
      ) l ON p.id = l.postId
      LEFT JOIN (
        SELECT postId, COUNT(*) as comments_count
        FROM FeedComments
        GROUP BY postId
      ) c ON p.id = c.postId
      LEFT JOIN FeedLikes ul ON p.id = ul.postId AND ul.userEmail = ?
      WHERE p.isActive = true
        AND (p.expiresAt IS NULL OR p.expiresAt > NOW())
        AND (
          p.visibility = 'all'
          OR FIND_IN_SET(?, p.visibility)
          OR p.authorEmail = ?
        )
    `;

    const params = [userEmail, userDesignation, userEmail];

    // Apply filters
    if (filter === 'pinned') {
      query += ` AND p.isPinned = true`;
    } else if (filter === 'my_posts') {
      query += ` AND p.authorEmail = ?`;
      params.push(userEmail);
    }

    query += ` ORDER BY p.isPinned DESC, p.createdAt DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), offset);

    console.log("📡 Executing feed posts query...");
    const [posts] = await pool.query(query, params);
    
    console.log(`✅ Found ${posts.length} posts`);

    // ===========================================
    // ENRICH POSTS WITH ADDITIONAL DATA
    // ===========================================
    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      
      // 1. GET MENTIONS
      const [mentions] = await pool.query(
        `SELECT mentionedEmail, mentionedName FROM FeedPostMentions WHERE postId = ?`,
        [post.id]
      );
      post.mentions = mentions.map(m => m.mentionedName);
      
      // 2. GET BULK MENTIONS FROM CONTENT
      const bulkMentions = [];
      const content = post.content || '';
      const bulkRegex = /@(FOH|BOH|EVERYONE|ALL)\b/gi;
      let match;
      while ((match = bulkRegex.exec(content)) !== null) {
        const mention = match[1].toUpperCase();
        if (!bulkMentions.includes(mention)) {
          bulkMentions.push(mention);
        }
      }
      post.bulkMentions = bulkMentions;
      
      // 3. GET MEDIA
      const [media] = await pool.query(
        `SELECT * FROM FeedMedia WHERE postId = ?`,
        [post.id]
      );
      
      // Set imageUrl/videoUrl from media
      if (media.length > 0) {
        const imageMedia = media.find(m => m.type === 'image');
        const videoMedia = media.find(m => m.type === 'video');
        
        if (imageMedia) post.imageUrl = imageMedia.url;
        if (videoMedia) post.videoUrl = videoMedia.url;
      }
      
      // 4. GET POLL
      const [polls] = await pool.query(
        `SELECT * FROM FeedPolls WHERE postId = ?`,
        [post.id]
      );
      
      if (polls.length > 0) {
        const poll = polls[0];
        
        // Get options for this poll
        const [options] = await pool.query(
          `SELECT * FROM FeedPollOptions WHERE pollId = ?`,
          [poll.id]
        );
        
        // Check if user has voted
        let hasVoted = false;
        if (userEmail) {
          const [votes] = await pool.query(
            `SELECT * FROM FeedPollVotes WHERE pollId = ? AND userEmail = ?`,
            [poll.id, userEmail]
          );
          hasVoted = votes.length > 0;
          
          // Check which option the user voted for
          if (hasVoted && votes.length > 0) {
            const userVote = votes[0];
            // Mark the selected option
            for (let opt of options) {
              opt.isSelected = opt.id === userVote.optionId;
            }
          }
        }
        
        // Calculate percentages
        const totalVotes = options.reduce((sum, opt) => sum + opt.votes, 0);
        const optionsWithPercentages = options.map(opt => ({
          id: opt.id,
          text: opt.optionText,
          votes: opt.votes,
          percentage: totalVotes > 0 ? (opt.votes / totalVotes) * 100 : 0,
          isSelected: opt.isSelected || false
        }));
        
        post.poll = {
          id: poll.id,
          question: poll.question,
          options: optionsWithPercentages,
          multipleChoice: poll.multipleChoice || false,
          endsAt: poll.endsAt,
          hasVoted: hasVoted
        };
      }
    }

    // ===========================================
    // FORMAT POSTS FOR FRONTEND
    // ===========================================
    const formattedPosts = posts.map(post => {
      // Parse attachments JSON safely
      let attachments = [];
      try {
        attachments = post.attachments ? JSON.parse(post.attachments) : [];
      } catch (e) {
        console.error(`❌ Error parsing attachments for post ${post.id}:`, e);
      }

      return {
        id: post.id,
        authorName: post.authorName,
        authorEmail: post.authorEmail,
        authorDesignation: post.authorDesignation || '',
        content: post.content || '',
        imageUrl: post.imageUrl || null,
        videoUrl: post.videoUrl || null,
        attachments: attachments,
        visibility: post.visibility || 'all',
        createdAt: post.createdAt,
        expiresAt: post.expiresAt,
        isPinned: post.isPinned === 1 || post.isPinned === true,
        isActive: post.isActive === 1 || post.isActive === true,
        likes: parseInt(post.likes_count) || 0,
        comments: parseInt(post.comments_count) || 0,
        likedByUser: !!post.liked_by_user,
        mentions: post.mentions || [],
        bulkMentions: post.bulkMentions || [], // 🔴 FIXED: Now included!
        poll: post.poll || null
      };
    });

    // Get total count for pagination
    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total FROM FeedPosts WHERE isActive = true`
    );

    console.log(`✅ Returning ${formattedPosts.length} formatted posts`);
    if (formattedPosts.length > 0) {
      console.log(`📝 First post bulkMentions: ${formattedPosts[0].bulkMentions}`);
    }

    return res.json({
      success: true,
      posts: formattedPosts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countResult[0].total,
        hasMore: offset + formattedPosts.length < countResult[0].total
      }
    });

  } catch (err) {
    console.error("❌ Error fetching feed posts:", err);
    return res.status(500).json({
      success: false,
      message: "Server error fetching posts",
      error: err.message
    });
  }
});

// Like/unlike a post
app.post("/feed/like", async (req, res) => {
  const { db, postId, userEmail } = req.body;

  if (!db || !postId || !userEmail) {
    return res.status(400).json({
      success: false,
      message: "Database, postId, and userEmail are required"
    });
  }

  try {
    const pool = getPool(db);

    // Check if like already exists
    const [existingLike] = await pool.query(
      "SELECT * FROM FeedLikes WHERE postId = ? AND userEmail = ?",
      [postId, userEmail]
    );

    if (existingLike.length > 0) {
      // Unlike - remove the like
      await pool.query(
        "DELETE FROM FeedLikes WHERE postId = ? AND userEmail = ?",
        [postId, userEmail]
      );

      // Get updated like count
      const [countResult] = await pool.query(
        "SELECT COUNT(*) as count FROM FeedLikes WHERE postId = ?",
        [postId]
      );

      return res.json({
        success: true,
        message: "Post unliked",
        liked: false,
        likes: countResult[0].count
      });
    } else {
      // Like - add new like
      const likeId = generateUniqueCode();
      await pool.query(
        "INSERT INTO FeedLikes (id, postId, userEmail, createdAt) VALUES (?, ?, ?, NOW())",
        [likeId, postId, userEmail]
      );

      // Get post author for notification
      const [postRows] = await pool.query(
        "SELECT authorName, authorEmail FROM FeedPosts WHERE id = ?",
        [postId]
      );

      if (postRows.length > 0) {
        const post = postRows[0];
        
        // Get user's name for notification
        const [userRows] = await pool.query(
          "SELECT name, lastName FROM Employees WHERE email = ?",
          [userEmail]
        );

        if (userRows.length > 0) {
          const userName = `${userRows[0].name} ${userRows[0].lastName}`;
          
          // Create notification for post author
          await pool.query(
            `INSERT INTO Notifications (targetRole, title, message, type, postId)
             VALUES (?, ?, ?, ?, ?)`,
            ['ALL', 'New Like', `${userName} liked your post`, 'FEED', postId]
          );
        }
      }

      // Get updated like count
      const [countResult] = await pool.query(
        "SELECT COUNT(*) as count FROM FeedLikes WHERE postId = ?",
        [postId]
      );

      return res.json({
        success: true,
        message: "Post liked",
        liked: true,
        likes: countResult[0].count
      });
    }

  } catch (err) {
    console.error("Error liking/unliking post:", err);
    return res.status(500).json({
      success: false,
      message: "Server error processing like",
      error: err.message
    });
  }
});

// GET LIKES FOR A POST
app.get("/feed/likes", async (req, res) => {
  const { db, postId } = req.query;

  if (!db || !postId) {
    return res.status(400).json({
      success: false,
      message: "Database and postId are required"
    });
  }

  try {
    const pool = getPool(db);

    const [likes] = await pool.query(
      `SELECT l.userEmail, l.createdAt, e.name, e.lastName, e.designation
       FROM FeedLikes l
       LEFT JOIN Employees e ON l.userEmail = e.email
       WHERE l.postId = ?
       ORDER BY l.createdAt DESC`,
      [postId]
    );

    const formattedLikes = likes.map(like => ({
      userEmail: like.userEmail,
      userName: like.name && like.lastName ? `${like.name} ${like.lastName}` : like.userEmail,
      designation: like.designation || '',
      createdAt: like.createdAt,
      timeAgo: _timeAgo(like.createdAt)
    }));

    return res.json({
      success: true,
      likes: formattedLikes,
      total: formattedLikes.length
    });

  } catch (err) {
    console.error("❌ Error fetching likes:", err);
    return res.status(500).json({
      success: false,
      message: "Server error fetching likes",
      error: err.message
    });
  }
});

// Helper function for time ago
function _timeAgo(date) {
  const now = new Date();
  const diff = Math.floor((now - new Date(date)) / 1000);
  
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(date).toLocaleDateString();
}

// Helper: safe boolean to tinyint
function _toTinyInt(v) {
  return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
}

// Helper: group reactions (frontend expects {counts:{}, total:int})
function _groupReactions(reactions = []) {
  const grouped = {};
  for (const reaction of reactions) {
    const emoji = reaction?.emoji;
    if (!emoji) continue;
    grouped[emoji] = (grouped[emoji] || 0) + 1;
  }
  return { counts: grouped, total: reactions.length };
}

// Get media by ID
app.get("/feed/media", async (req, res) => {
  const { db, mediaId } = req.query;

  if (!db || !mediaId) {
    return res.status(400).json({
      success: false,
      message: "Database and mediaId are required"
    });
  }

  try {
    const pool = getPool(db);
    
    const [media] = await pool.query(
      `SELECT * FROM FeedMedia WHERE id = ?`,
      [mediaId]
    );

    if (media.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Media not found"
      });
    }

    return res.json({
      success: true,
      url: media[0].url,
      type: media[0].type
    });

  } catch (err) {
    console.error("Error fetching media:", err);
    return res.status(500).json({
      success: false,
      message: "Server error fetching media",
      error: err.message
    });
  }
});

// Delete comment
app.delete("/feed/comment/:commentId", async (req, res) => {
  const { db, userEmail } = req.query;
  const { commentId } = req.params;

  if (!db || !commentId || !userEmail) {
    return res.status(400).json({
      success: false,
      message: "Database, commentId, and userEmail are required"
    });
  }

  try {
    const pool = getPool(db);

    // Check if user is the comment author or post author
    const [commentRows] = await pool.query(
      `SELECT c.*, p.authorEmail 
       FROM FeedComments c
       JOIN FeedPosts p ON c.postId = p.id
       WHERE c.id = ?`,
      [commentId]
    );

    if (commentRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Comment not found"
      });
    }

    const comment = commentRows[0];
    const isAuthor = comment.userEmail === userEmail;
    const isPostAuthor = comment.authorEmail === userEmail;

    if (!isAuthor && !isPostAuthor) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to delete this comment"
      });
    }

    // Delete comment - foreign key cascade will delete replies and reactions
    await pool.query(
      "DELETE FROM FeedComments WHERE id = ?",
      [commentId]
    );

    // Get updated comment count
    const [countResult] = await pool.query(
      "SELECT COUNT(*) as count FROM FeedComments WHERE postId = ?",
      [comment.postId]
    );

    return res.json({
      success: true,
      message: "Comment deleted successfully",
      comments: countResult[0].count
    });

  } catch (err) {
    console.error("❌ Error deleting comment:", err);
    return res.status(500).json({
      success: false,
      message: "Server error deleting comment",
      error: err.message
    });
  }
});

// ADD COMMENT (supports parentCommentId = reply) + optional mention notifications
app.post("/feed/comment", async (req, res) => {
  const { db, postId, userEmail, content, parentCommentId } = req.body;

  if (!db || !postId || !userEmail || !content) {
    return res.status(400).json({
      success: false,
      message: "Database, postId, userEmail, and content are required"
    });
  }

  try {
    const pool = getPool(db);
    const commentId = generateUniqueCode();

    // Ensure post exists
    const [postRows] = await pool.query(
      `SELECT id, authorEmail, authorName FROM FeedPosts WHERE id = ? AND isActive = true`,
      [postId]
    );

    if (!postRows || postRows.length === 0) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    // Get user info
    const [userRows] = await pool.query(
      `SELECT name, lastName, designation FROM Employees WHERE email = ?`,
      [userEmail]
    );

    if (!userRows || userRows.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const user = userRows[0];
    const userName = `${user.name} ${user.lastName}`;

    // If replying, ensure parent exists and belongs to same post
    let parentId = parentCommentId || null;
    if (parentId) {
      const [parentRows] = await pool.query(
        `SELECT id, postId, userEmail, userName FROM FeedComments WHERE id = ?`,
        [parentId]
      );
      if (!parentRows || parentRows.length === 0) {
        parentId = null; // silently fallback (or you can 400)
      } else if (parentRows[0].postId !== postId) {
        return res.status(400).json({ success: false, message: "Invalid parent comment" });
      }
    }

    // Insert comment (parentCommentId supported)
    await pool.query(
      `INSERT INTO FeedComments
       (id, postId, parentCommentId, userEmail, userName, userDesignation, content, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        commentId,
        postId,
        parentId,
        userEmail,
        userName,
        user.designation || '',
        content
      ]
    );

    // Update comments count is derived in query, but frontend reads count from posts endpoint.
    // Optional: notify post author or parent comment author
    try {
      const post = postRows[0];

      let targetEmail = post.authorEmail;
      let title = "💬 New Comment";
      let msg = `${userName} commented on your post: "${content.substring(0, 60)}${content.length > 60 ? '...' : ''}"`;
      let type = "COMMENT";

      if (parentId) {
        const [parentRows] = await pool.query(
          `SELECT userEmail, userName FROM FeedComments WHERE id = ?`,
          [parentId]
        );
        if (parentRows.length > 0) {
          targetEmail = parentRows[0].userEmail;
          title = "💬 New Reply";
          msg = `${userName} replied to your comment: "${content.substring(0, 60)}${content.length > 60 ? '...' : ''}"`;
          type = "REPLY";
        }
      }

      if (targetEmail && targetEmail !== userEmail) {
        await pool.query(
          `INSERT INTO Notifications
           (targetRole, targetEmail, authorEmail, title, message, type, postId, isRead, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            'USER',
            targetEmail,
            userEmail,
            title,
            msg,
            type,
            postId,
            false,
            new Date()
          ]
        );
      }
    } catch (notifErr) {
      console.error("⚠️ Notification error (ignored):", notifErr.message);
    }

    // Return created comment in the shape your UI expects
    return res.json({
      success: true,
      message: "Comment added successfully",
      comment: {
        id: commentId,
        postId,
        parentCommentId: parentId,
        userEmail,
        userName,
        userDesignation: user.designation || '',
        content,
        createdAt: new Date(),
        reactions: { counts: {}, total: 0 },
        replies: []
      }
    });

  } catch (err) {
    console.error("❌ Error adding comment:", err);
    return res.status(500).json({
      success: false,
      message: "Server error adding comment",
      error: err.message
    });
  }
});

// GET COMMENTS WITH REPLIES + REACTIONS (single correct version)
app.get("/feed/comments", async (req, res) => {
  const { db, postId } = req.query;

  if (!db || !postId) {
    return res.status(400).json({
      success: false,
      message: "Database and postId are required"
    });
  }

  try {
    const pool = getPool(db);

    // Fetch comments in ASC so replies naturally come after parent
    const [comments] = await pool.query(
      `SELECT c.*,
              e.name, e.lastName, e.designation
       FROM FeedComments c
       LEFT JOIN Employees e ON c.userEmail = e.email
       WHERE c.postId = ?
       ORDER BY c.createdAt ASC`,
      [postId]
    );

    const ids = comments.map(c => c.id);
    let reactions = [];

    if (ids.length > 0) {
      const [reactionRows] = await pool.query(
        `SELECT * FROM CommentReactions WHERE commentId IN (?) ORDER BY createdAt ASC`,
        [ids]
      );
      reactions = reactionRows;
    }

    const reactionsByComment = {};
    for (const r of reactions) {
      if (!reactionsByComment[r.commentId]) reactionsByComment[r.commentId] = [];
      reactionsByComment[r.commentId].push(r);
    }

    // Map all comments
    const byId = {};
    const roots = [];

    for (const c of comments) {
      const formatted = {
        id: c.id,
        postId: c.postId,
        parentCommentId: c.parentCommentId,
        userEmail: c.userEmail,
        userName: c.userName || (c.name && c.lastName ? `${c.name} ${c.lastName}` : c.userEmail),
        userDesignation: c.userDesignation || c.designation || '',
        content: c.content,
        createdAt: c.createdAt,
        reactions: _groupReactions(reactionsByComment[c.id] || []),
        replies: []
      };
      byId[c.id] = formatted;
    }

    // Build tree
    for (const id in byId) {
      const c = byId[id];
      const parentId = c.parentCommentId;
      if (!parentId || !byId[parentId]) {
        roots.push(c);
      } else {
        byId[parentId].replies.push(c);
      }
    }

    // Sort replies by date
    for (const c of roots) {
      c.replies.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    }

    return res.json({ success: true, comments: roots });

  } catch (err) {
    console.error("❌ Error fetching comments:", err);
    return res.status(500).json({
      success: false,
      message: "Server error fetching comments",
      error: err.message
    });
  }
});

// TOGGLE REACTION ON COMMENT
app.post("/feed/comment/reaction", async (req, res) => {
  const { db, commentId, userEmail, emoji } = req.body;

  if (!db || !commentId || !userEmail || !emoji) {
    return res.status(400).json({
      success: false,
      message: "Database, commentId, userEmail, and emoji are required"
    });
  }

  try {
    const pool = getPool(db);

    // Ensure comment exists
    const [commentRows] = await pool.query(
      `SELECT id, postId, userEmail FROM FeedComments WHERE id = ?`,
      [commentId]
    );
    if (!commentRows || commentRows.length === 0) {
      return res.status(404).json({ success: false, message: "Comment not found" });
    }

    const [existing] = await pool.query(
      `SELECT id FROM CommentReactions WHERE commentId = ? AND userEmail = ? AND emoji = ?`,
      [commentId, userEmail, emoji]
    );

    if (existing.length > 0) {
      await pool.query(
        `DELETE FROM CommentReactions WHERE commentId = ? AND userEmail = ? AND emoji = ?`,
        [commentId, userEmail, emoji]
      );
      return res.json({ success: true, action: "removed" });
    }

    const reactionId = generatePostId();
    await pool.query(
      `INSERT INTO CommentReactions (id, commentId, userEmail, emoji, createdAt)
       VALUES (?, ?, ?, ?, NOW())`,
      [reactionId, commentId, userEmail, emoji]
    );

    return res.json({ success: true, action: "added" });

  } catch (err) {
    console.error("❌ Error toggling reaction:", err);
    return res.status(500).json({
      success: false,
      message: "Server error toggling reaction",
      error: err.message
    });
  }
});

// GET REACTIONS FOR COMMENT
app.get("/feed/comment/reactions", async (req, res) => {
  const { db, commentId } = req.query;

  if (!db || !commentId) {
    return res.status(400).json({
      success: false,
      message: "Database and commentId are required"
    });
  }

  try {
    const pool = getPool(db);

    const [reactions] = await pool.query(
      `SELECT r.*, e.name, e.lastName, e.designation
       FROM CommentReactions r
       LEFT JOIN Employees e ON r.userEmail = e.email
       WHERE r.commentId = ?
       ORDER BY r.createdAt DESC`,
      [commentId]
    );

    const formattedReactions = reactions.map(r => ({
      id: r.id,
      userEmail: r.userEmail,
      userName: r.name && r.lastName ? `${r.name} ${r.lastName}` : r.userEmail,
      designation: r.designation || '',
      emoji: r.emoji,
      createdAt: r.createdAt
    }));

    // Group by emoji
    const grouped = {};
    for (const reaction of formattedReactions) {
      if (!grouped[reaction.emoji]) {
        grouped[reaction.emoji] = [];
      }
      grouped[reaction.emoji].push(reaction);
    }

    return res.json({
      success: true,
      reactions: formattedReactions,
      grouped: grouped,
      total: formattedReactions.length
    });

  } catch (err) {
    console.error("❌ Error fetching reactions:", err);
    return res.status(500).json({
      success: false,
      message: "Server error fetching reactions",
      error: err.message
    });
  }
});

// Pin/unpin post (Manager/AM only)
app.post("/feed/pin", async (req, res) => {
  const { db, postId, userEmail, pin } = req.body;

  if (!db || !postId || !userEmail) {
    return res.status(400).json({
      success: false,
      message: "Database, postId, and userEmail are required",
    });
  }

  const email = String(userEmail).trim().toLowerCase();

  // ✅ MAIN pool (yassir_access) — same as /login
  const authPool = pool;

  // ✅ WORKSPACE pool (Feed tables)
  const workspacePool = getPool(db);

  try {
    // 1) Permission check from MAIN DB
    const [userRows] = await authPool.query(
      `SELECT TRIM(LOWER(COALESCE(\`Access\`, ''))) AS access
       FROM users
       WHERE (LOWER(TRIM(\`Email\`)) = ? OR LOWER(TRIM(email)) = ?)
         AND TRIM(LOWER(db_name)) = TRIM(LOWER(?))
       LIMIT 1`,
      [email, email, db]
    );

    console.log("🔎 PIN CHECK (MAIN DB yassir_access):", {
      db,
      postId,
      email,
      matchedRows: userRows?.length || 0,
      row: userRows?.[0] || null,
    });

    if (!userRows || userRows.length === 0) {
      return res.status(403).json({
        success: false,
        message: `User not found for this workspace`,
      });
    }

    const access = userRows[0].access; // normalized
    const canPin = ["admin", "am", "assistant manager"].includes(access);

    if (!canPin) {
      return res.status(403).json({
        success: false,
        message: `Only admin/AM can pin/unpin posts. Access='${access}'`,
      });
    }

    // 2) Update post in WORKSPACE DB
    const pinVal = pin ? 1 : 0;

    const [result] = await workspacePool.query(
      `UPDATE FeedPosts SET isPinned = ? WHERE id = ? AND isActive = true`,
      [pinVal, postId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    console.log(
      `✅ Post ${pinVal === 1 ? "pinned" : "unpinned"} successfully | db=${db} | postId=${postId} | by=${email} | access=${access}`
    );

    return res.json({
      success: true,
      message: pinVal === 1 ? "Post pinned successfully" : "Post unpinned successfully",
      isPinned: pinVal === 1,
    });
  } catch (err) {
    console.error("❌ Error pinning/unpinning post:", err);
    return res.status(500).json({
      success: false,
      message: "Server error updating post",
      error: err.message,
    });
  }
});

// Vote in a poll
app.post("/feed/poll/vote", async (req, res) => {
  const { db, pollId, optionId, userEmail } = req.body;

  if (!db || !pollId || !optionId || !userEmail) {
    return res.status(400).json({
      success: false,
      message: "Database, pollId, optionId, and userEmail are required"
    });
  }

  try {
    const pool = getPool(db);

    // Poll exists & active
    const [pollRows] = await pool.query(
      `SELECT id, endsAt FROM FeedPolls WHERE id = ?`,
      [pollId]
    );
    if (!pollRows || pollRows.length === 0) {
      return res.status(404).json({ success: false, message: "Poll not found" });
    }
    if (pollRows[0].endsAt && new Date(pollRows[0].endsAt) < new Date()) {
      return res.status(400).json({ success: false, message: "This poll has ended" });
    }

    // Validate option belongs to poll
    const [optRows] = await pool.query(
      `SELECT id FROM FeedPollOptions WHERE id = ? AND pollId = ?`,
      [optionId, pollId]
    );
    if (!optRows || optRows.length === 0) {
      return res.status(400).json({ success: false, message: "Invalid option for this poll" });
    }

    // Already voted?
    const [existingVote] = await pool.query(
      `SELECT id FROM FeedPollVotes WHERE pollId = ? AND userEmail = ?`,
      [pollId, userEmail]
    );
    if (existingVote.length > 0) {
      return res.status(400).json({ success: false, message: "You have already voted in this poll" });
    }

    const voteId = generatePostId();
    await pool.query(
      `INSERT INTO FeedPollVotes (id, pollId, optionId, userEmail, createdAt)
       VALUES (?, ?, ?, ?, NOW())`,
      [voteId, pollId, optionId, userEmail]
    );

    await pool.query(
      `UPDATE FeedPollOptions SET votes = votes + 1 WHERE id = ?`,
      [optionId]
    );

    return res.json({ success: true, message: "Vote recorded successfully" });

  } catch (err) {
    console.error("❌ Error voting in poll:", err);
    return res.status(500).json({
      success: false,
      message: "Server error voting in poll",
      error: err.message
    });
  }
});

// GET POLL VOTES 
app.get("/feed/poll/votes", async (req, res) => {
  const { db, pollId } = req.query;

  if (!db || !pollId) {
    return res.status(400).json({
      success: false,
      message: "Database and pollId are required"
    });
  }

  try {
    const pool = getPool(db);

    const [votes] = await pool.query(
      `SELECT v.userEmail, v.optionId, v.createdAt, 
              e.name, e.lastName, e.designation,
              o.optionText
       FROM FeedPollVotes v
       LEFT JOIN Employees e ON v.userEmail = e.email
       LEFT JOIN FeedPollOptions o ON v.optionId = o.id
       WHERE v.pollId = ?
       ORDER BY v.createdAt DESC`,
      [pollId]
    );

    const formattedVotes = votes.map(vote => ({
      userEmail: vote.userEmail,
      userName: vote.name && vote.lastName ? `${vote.name} ${vote.lastName}` : vote.userEmail,
      designation: vote.designation || '',
      optionId: vote.optionId,
      optionText: vote.optionText || 'Unknown option',
      createdAt: vote.createdAt
    }));

    return res.json({
      success: true,
      votes: formattedVotes
    });

  } catch (err) {
    console.error("❌ Error fetching poll votes:", err);
    return res.status(500).json({
      success: false,
      message: "Server error fetching poll votes",
      error: err.message
    });
  }
});

// CHANGE VOTE IN A POLL (UNVOTE THEN VOTE AGAIN)
app.post("/feed/poll/change-vote", async (req, res) => {
  const { db, pollId, oldOptionId, newOptionId, userEmail } = req.body;

  if (!db || !pollId || !newOptionId || !userEmail) {
    return res.status(400).json({
      success: false,
      message: "Database, pollId, newOptionId, and userEmail are required"
    });
  }

  try {
    const pool = getPool(db);

    const [pollRows] = await pool.query(
      `SELECT id, endsAt FROM FeedPolls WHERE id = ?`,
      [pollId]
    );
    if (!pollRows || pollRows.length === 0) {
      return res.status(404).json({ success: false, message: "Poll not found" });
    }
    if (pollRows[0].endsAt && new Date(pollRows[0].endsAt) < new Date()) {
      return res.status(400).json({ success: false, message: "This poll has ended" });
    }

    // Validate new option belongs to poll
    const [optRows] = await pool.query(
      `SELECT id FROM FeedPollOptions WHERE id = ? AND pollId = ?`,
      [newOptionId, pollId]
    );
    if (!optRows || optRows.length === 0) {
      return res.status(400).json({ success: false, message: "Invalid option for this poll" });
    }

    // Find existing vote (source of truth)
    const [existingVotes] = await pool.query(
      `SELECT optionId FROM FeedPollVotes WHERE pollId = ? AND userEmail = ?`,
      [pollId, userEmail]
    );

    const existingOptionId = existingVotes.length > 0 ? existingVotes[0].optionId : null;
    const removeOptionId = oldOptionId || existingOptionId;

    if (removeOptionId) {
      await pool.query(
        `DELETE FROM FeedPollVotes WHERE pollId = ? AND userEmail = ?`,
        [pollId, userEmail]
      );
      await pool.query(
        `UPDATE FeedPollOptions SET votes = GREATEST(votes - 1, 0) WHERE id = ?`,
        [removeOptionId]
      );
    }

    const voteId = generatePostId();
    await pool.query(
      `INSERT INTO FeedPollVotes (id, pollId, optionId, userEmail, createdAt)
       VALUES (?, ?, ?, ?, NOW())`,
      [voteId, pollId, newOptionId, userEmail]
    );
    await pool.query(
      `UPDATE FeedPollOptions SET votes = votes + 1 WHERE id = ?`,
      [newOptionId]
    );

    return res.json({ success: true, message: "Vote changed successfully" });

  } catch (err) {
    console.error("❌ Error changing vote in poll:", err);
    return res.status(500).json({
      success: false,
      message: "Server error changing vote in poll",
      error: err.message
    });
  }
});

// Delete post (author, Manager, AM only)
app.delete("/feed/post/:postId", async (req, res) => {
  const { db, userEmail } = req.query;
  const { postId } = req.params;

  if (!db || !postId || !userEmail) {
    return res.status(400).json({
      success: false,
      message: "Database, postId, and userEmail are required",
    });
  }

  const email = String(userEmail).trim().toLowerCase();

  // ✅ MAIN pool (yassir_access)
  const authPool = pool;

  // ✅ WORKSPACE pool (Feed tables)
  const workspacePool = getPool(db);
  const conn = await workspacePool.getConnection();

  try {
    // 1) Post exists?
    const [postRows] = await conn.query(
      `SELECT id FROM FeedPosts WHERE id = ?`,
      [postId]
    );

    if (!postRows || postRows.length === 0) {
      conn.release();
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    // 2) Permission check from MAIN DB
    const [userRows] = await authPool.query(
      `SELECT TRIM(LOWER(COALESCE(\`Access\`, ''))) AS access
       FROM users
       WHERE (LOWER(TRIM(\`Email\`)) = ? OR LOWER(TRIM(email)) = ?)
         AND TRIM(LOWER(db_name)) = TRIM(LOWER(?))
       LIMIT 1`,
      [email, email, db]
    );

    console.log("🔎 DELETE CHECK (MAIN DB yassir_access):", {
      db,
      postId,
      email,
      matchedRows: userRows?.length || 0,
      row: userRows?.[0] || null,
    });

    if (!userRows || userRows.length === 0) {
      conn.release();
      return res.status(403).json({
        success: false,
        message: "User not found for this workspace",
      });
    }

    const access = userRows[0].access;
    const canDelete = ["am", "assistant manager"].includes(access); // ✅ AM only

    if (!canDelete) {
      conn.release();
      return res.status(403).json({
        success: false,
        message: `Only AM can delete posts. Access='${access}'`,
      });
    }

    await conn.beginTransaction();

    // 3) Delete comment reactions for this post
    await conn.query(
      `DELETE cr
       FROM CommentReactions cr
       JOIN FeedComments fc ON fc.id = cr.commentId
       WHERE fc.postId = ?`,
      [postId]
    );

    // 4) Delete comments
    await conn.query(`DELETE FROM FeedComments WHERE postId = ?`, [postId]);

    // 5) Delete likes
    await conn.query(`DELETE FROM FeedLikes WHERE postId = ?`, [postId]);

    // 6) Delete mentions
    await conn.query(`DELETE FROM FeedPostMentions WHERE postId = ?`, [postId]);

    // 7) Delete media
    await conn.query(`DELETE FROM FeedMedia WHERE postId = ?`, [postId]);

    // 8) Delete poll data
    const [pollRows] = await conn.query(
      `SELECT id FROM FeedPolls WHERE postId = ?`,
      [postId]
    );

    if (pollRows && pollRows.length > 0) {
      const pollId = pollRows[0].id;
      await conn.query(`DELETE FROM FeedPollVotes WHERE pollId = ?`, [pollId]);
      await conn.query(`DELETE FROM FeedPollOptions WHERE pollId = ?`, [pollId]);
      await conn.query(`DELETE FROM FeedPolls WHERE id = ?`, [pollId]);
    }

    // 9) Delete post
    await conn.query(`DELETE FROM FeedPosts WHERE id = ?`, [postId]);

    await conn.commit();
    conn.release();

    console.log(
      `✅ Post deleted successfully | db=${db} | postId=${postId} | by=${email} | access=${access}`
    );

    return res.json({ success: true, message: "Post deleted successfully" });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    conn.release();

    console.error("❌ Error deleting post:", err);
    return res.status(500).json({
      success: false,
      message: "Server error deleting post",
      error: err.message,
    });
  }
});

// Get user's feed interactions (likes, comments)
app.get("/feed/user-interactions", async (req, res) => {
  const { db, userEmail } = req.query;

  if (!db || !userEmail) {
    return res.status(400).json({
      success: false,
      message: "Database and userEmail are required"
    });
  }

  try {
    const pool = getPool(db);

    // Get user's liked posts
    const [likedPosts] = await pool.query(
      `SELECT l.postId, l.createdAt as likedAt,
              p.content, p.authorName, p.createdAt as postCreatedAt
       FROM FeedLikes l
       JOIN FeedPosts p ON l.postId = p.id
       WHERE l.userEmail = ?
       ORDER BY l.createdAt DESC
       LIMIT 50`,
      [userEmail]
    );

    // Get user's comments
    const [userComments] = await pool.query(
      `SELECT c.*, p.content as postContent, p.authorName as postAuthor
       FROM FeedComments c
       JOIN FeedPosts p ON c.postId = p.id
       WHERE c.userEmail = ?
       ORDER BY c.createdAt DESC
       LIMIT 50`,
      [userEmail]
    );

    return res.json({
      success: true,
      likedPosts,
      comments: userComments
    });

  } catch (err) {
    console.error("Error fetching user interactions:", err);
    return res.status(500).json({
      success: false,
      message: "Server error fetching interactions",
      error: err.message
    });
  }
});

// Get employees for mentions (filtered by search term)
app.get("/employees/search", async (req, res) => {
  const { db, search, excludeEmail, limit = 10 } = req.query;

  if (!db) {
    return res.status(400).json({
      success: false,
      message: "Database is required"
    });
  }

  try {
    const pool = getPool(db);
    
    // ✅ FIXED: Better search that works with first name only
    let query = `
      SELECT name, lastName, email, designation 
      FROM Employees 
      WHERE 1=1
    `;
    const params = [];

    if (search && search.trim() !== '') {
      const searchTerm = `%${search.trim()}%`;
      // Search in name, lastName, and full name
      query += ` AND (
        name LIKE ? OR 
        lastName LIKE ? OR 
        CONCAT(name, ' ', lastName) LIKE ? OR 
        CONCAT(lastName, ' ', name) LIKE ? OR
        email LIKE ?
      )`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
    }

    if (excludeEmail) {
      query += ` AND email != ?`;
      params.push(excludeEmail);
    }

    query += ` ORDER BY 
      CASE 
        WHEN name LIKE ? THEN 1
        WHEN lastName LIKE ? THEN 2
        ELSE 3
      END, 
      name, 
      lastName 
      LIMIT ?`;
    
    if (search && search.trim() !== '') {
      const exactTerm = `${search.trim()}%`;
      params.push(exactTerm, exactTerm);
    } else {
      params.push('%%', '%%');
    }
    params.push(parseInt(limit));

    const [rows] = await pool.query(query, params);

    const employees = rows.map(emp => ({
      name: emp.name,
      lastName: emp.lastName,
      fullName: `${emp.name} ${emp.lastName}`,
      email: emp.email,
      designation: emp.designation || '',
      avatar: emp.name.charAt(0) + (emp.lastName ? emp.lastName.charAt(0) : ''),
    }));

    console.log(`Found ${employees.length} employees for search: "${search}"`);
    
    return res.json({
      success: true,
      employees
    });

  } catch (err) {
    console.error("Error searching employees:", err);
    return res.status(500).json({
      success: false,
      message: "Server error searching employees",
      error: err.message
    });
  }
});

// ==================== EXISTING ENDPOINTS ====================

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Solura backend is running" });
});

// In your Flutter app's backend (solura-backend.onrender.com)
// Helper function per ottenere il pool queryable
function getQueryPool() {
    return pool.promise ? pool.promise() : pool;
}

// Login Endpoint
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ success: false, message: "Email and password required" });

  try {
    const trimmedEmail = email.trim();
    const [rows] = await pool.query(
      "SELECT id, Email, Password, Access, db_name FROM users WHERE Email = ?", // ← AGGIUNTO id
      [trimmedEmail]
    );

    if (!rows || rows.length === 0)
      return res.json({ success: false, message: "Invalid email or password" });

    const databases = [];
    let loginSuccess = false;
    let userId = null; // ← Variabile per salvare userId

    for (const row of rows) {
      const match = await bcrypt.compare(password, row.Password);
      if (match) {
        loginSuccess = true;
        databases.push({ db_name: row.db_name, access: row.Access });
        userId = row.id; // ← Prendi l'id del primo record valido
      }
    }

    if (!loginSuccess) return res.json({ success: false, message: "Invalid email or password" });
    if (databases.length === 0) return res.json({ success: false, message: "No databases available" });

    // LOG per debug
    console.log(`✅ Login successful for ${trimmedEmail} (userId: ${userId})`);
    console.log(`📚 Databases: ${JSON.stringify(databases)}`);

    return res.json({ 
      success: true, 
      message: "Login successful", 
      email: trimmedEmail, 
      userId: userId, // ← AGGIUNTO userId
      databases 
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Endpoint for Flutter app to register FCM tokens - FIXED VERSION
app.post("/register-device", async (req, res) => {
  const { userId, email, fcmToken, deviceType, dbName } = req.body;
  
  // 🟢 LOG 1: Ricevuta richiesta
  console.log("=================================");
  console.log("📱 REGISTER-DEVICE RICHIESTA RICEVUTA");
  console.log("=================================");
  console.log(`📧 Email: ${email}`);
  console.log(`🆔 UserId: ${userId} (type: ${typeof userId})`);
  console.log(`📱 Device Type from Flutter: ${deviceType} (type: ${typeof deviceType})`);
  console.log(`💾 Database: ${dbName}`);
  console.log(`🔑 FCM Token: ${fcmToken ? fcmToken.substring(0, 20) + '...' : 'MANCANTE'}`);
  console.log("=================================");
  
  // Validazione input
  if (!email || !fcmToken || !dbName) {
    console.log("❌ ERRORE: Dati mancanti!", { email, fcmToken: !!fcmToken, dbName });
    return res.status(400).json({ 
      success: false, 
      message: "Missing required fields" 
    });
  }
  
  try {
    const pool = getPool(dbName);
    console.log(`🔌 Connesso al database: ${dbName}`);
    
    // 🔍 Check the table structure first
    console.log("🔍 Verifico struttura tabella user_devices...");
    const [columns] = await pool.query("SHOW COLUMNS FROM user_devices");
    console.log("📊 Colonne tabella:");
    columns.forEach(col => {
      console.log(`   - ${col.Field}: ${col.Type} (Default: ${col.Default})`);
    });
    
    // Check if device_type column has a default value
    const deviceTypeColumn = columns.find(col => col.Field === 'device_type');
    if (deviceTypeColumn && deviceTypeColumn.Default) {
      console.log(`⚠️ ATTENZIONE: device_type ha default value: '${deviceTypeColumn.Default}'`);
      console.log(`   Questo potrebbe sovrascrivere il valore '${deviceType}' se non viene passato correttamente`);
    }
    
    // LOG 2: Controllo se token esiste
    console.log(`🔍 Cerco token esistente per email: ${email}`);
    
    const [existing] = await pool.query(
      "SELECT id, created_at, updated_at, device_type FROM user_devices WHERE email = ? AND fcm_token = ?",
      [email, fcmToken]
    );
    
    if (existing.length > 0) {
      // 🟢 LOG 3: Token già esistente
      console.log("✅ TOKEN GIA' REGISTRATO - Aggiorno timestamp");
      console.log(`   ID dispositivo: ${existing[0].id}`);
      console.log(`   Device Type attuale nel DB: ${existing[0].device_type}`);
      console.log(`   Creato il: ${existing[0].created_at}`);
      console.log(`   Ultimo aggiornamento: ${existing[0].updated_at}`);
      
      // Also update device_type if it changed
      if (existing[0].device_type !== deviceType) {
        console.log(`🔄 Aggiorno device_type da '${existing[0].device_type}' a '${deviceType}'`);
        await pool.query(
          "UPDATE user_devices SET updated_at = NOW(), device_type = ? WHERE id = ?",
          [deviceType, existing[0].id]
        );
      } else {
        await pool.query(
          "UPDATE user_devices SET updated_at = NOW() WHERE id = ?",
          [existing[0].id]
        );
      }
      
      console.log(`✅ Dispositivo aggiornato con successo (ID: ${existing[0].id})`);
    } else {
      // 🟢 LOG 4: Nuovo token
      console.log("🆕 NUOVO DISPOSITIVO - Creo nuova registrazione");
      console.log(`   Valori da inserire:`);
      console.log(`   - user_id: ${userId} (${typeof userId})`);
      console.log(`   - email: ${email}`);
      console.log(`   - fcm_token: ${fcmToken.substring(0, 20)}...`);
      console.log(`   - device_type: '${deviceType}' (${typeof deviceType})`);
      
      // NOTA: i nomi dei campi sono: user_id, email, fcm_token, device_type
      const [result] = await pool.query(
        `INSERT INTO user_devices (user_id, email, fcm_token, device_type) 
         VALUES (?, ?, ?, ?)`,
        [userId, email, fcmToken, deviceType]
      );
      
      console.log(`✅ Nuovo dispositivo registrato con ID: ${result.insertId}`);
      
      // Verify what was actually inserted
      const [newDevice] = await pool.query(
        "SELECT id, device_type, created_at FROM user_devices WHERE id = ?",
        [result.insertId]
      );
      console.log(`🔍 Verifica inserimento:`);
      console.log(`   - ID: ${newDevice[0].id}`);
      console.log(`   - device_type nel DB: '${newDevice[0].device_type}'`);
      console.log(`   - Corrisponde a quello inviato? ${newDevice[0].device_type === deviceType ? '✅ SI' : '❌ NO'}`);
    }
    
    // LOG 5: Verifica quanti dispositivi ha l'utente
    const [count] = await pool.query(
      "SELECT COUNT(*) as total FROM user_devices WHERE email = ?",
      [email]
    );
    console.log(`📊 Totale dispositivi registrati per ${email}: ${count[0].total}`);
    
    // LOG 6: Lista di tutti i dispositivi dell'utente con tutti i dettagli
    const [devices] = await pool.query(
      `SELECT id, device_type, created_at, updated_at 
       FROM user_devices 
       WHERE email = ? 
       ORDER BY updated_at DESC`,
      [email]
    );
    console.log("📱 Dispositivi attivi (dettaglio completo):");
    devices.forEach((d, index) => {
      console.log(`   ${index + 1}. ID: ${d.id}`);
      console.log(`      Tipo nel DB: '${d.device_type}'`);
      console.log(`      Creato: ${d.created_at}`);
      console.log(`      Aggiornato: ${d.updated_at}`);
    });
    
    console.log("=================================");
    console.log("✅ REGISTRAZIONE COMPLETATA CON SUCCESSO");
    console.log("=================================");
    
    res.json({ success: true });
    
  } catch (err) {
    console.log("=================================");
    console.log("❌ ERRORE DURANTE LA REGISTRAZIONE");
    console.log("=================================");
    console.error("Errore:", err);
    console.log("=================================");
    
    res.status(500).json({ 
      success: false, 
      message: "Server error" 
    });
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
    const pool = getPool(db);
    const [rows] = await pool.query(
      "SELECT name, lastName, wage, designation FROM Employees WHERE email = ?",
      [email]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    const employee = rows[0];
    return res.json({ 
      success: true, 
      name: employee.name, 
      lastName: employee.lastName,
      wage: employee.wage,
      designation: employee.designation
    });
  } catch (err) {
    console.error("Error fetching employee:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Employees List
app.get("/employees", async (req, res) => {
  const { db, email } = req.query;

  if (!db) {
    return res.status(400).json({ success: false, message: "Database is required" });
  }

  try {
    const pool = getPool(db);

    // NOTE: adjust column names if your table uses different naming
    // assuming Employees has: name, lastName, email, position, designation, profileImage, profileImageMime
    const [rows] = await pool.query(`
      SELECT 
        name,
        lastName,
        email,
        position,
        designation,
        profileImage,
        profileImageMime
      FROM Employees
      WHERE situation IS NULL
      OR TRIM(situation) = ''
      ORDER BY
        FIELD(UPPER(TRIM(designation)), 'AM', 'MANAGER', 'SUPERVISOR', 'TM') ASC,
        lastName ASC,
        name ASC
    `);

    const employees = rows.map(r => {
      let profileImage = null;

      // If profileImage is stored as blob, convert to base64
      if (r.profileImage) {
        profileImage = Buffer.from(r.profileImage).toString("base64");
      }

      return {
        name: r.name ?? "",
        lastName: r.lastName ?? "",
        email: r.email ?? "",
        position: r.position ?? "",
        designation: (r.designation ?? "").toString().trim(),
        profileImage, // null if not present
        profileImageMime: r.profileImageMime ?? null,
      };
    });

    res.json({
      success: true,
      currentEmail: (email ?? "").toString().trim(),
      employees,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// Profile Endpoint
app.get("/profile/employees", async (req, res) => {
  const { db, email } = req.query;

  if (!db || !email) {
    return res.status(400).json({ success: false, message: "db and email are required" });
  }

  try {
    const pool = getPool(db);

    const [rows] = await pool.query(
      `
      SELECT
        name,
        lastName,
        email,
        phone,
        address,
        nin,
        wage,
        Salary,
        SalaryPrice,
        designation,
        position,
        contractHours,
        dateStart,
        startHoliday,
        profileImage,
        profileImageMime
      FROM Employees
      WHERE email = ?
      LIMIT 1
      `,
      [email]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    const e = rows[0];

    const salaryYes =
      String(e.Salary ?? "").trim().toLowerCase() === "yes" || Number(e.Salary) === 1;

    // ✅ LONGBLOB comes as Buffer -> convert to base64 string
    const profileImageBase64 = Buffer.isBuffer(e.profileImage)
      ? e.profileImage.toString("base64")
      : "";

    res.json({
      success: true,
      employee: {
        name: e.name ?? "",
        lastName: e.lastName ?? "",
        email: e.email ?? "",
        phone: e.phone ?? "",
        address: e.address ?? "",
        nin: e.nin ?? "",

        designation: e.designation ?? "",
        position: e.position ?? "",

        contractHours: e.contractHours ?? "",
        dateStart: e.dateStart ?? "",
        startHoliday: e.startHoliday ?? 0,

        salaryYes,
        wage: salaryYes ? null : (e.wage ?? null),
        salaryPrice: salaryYes ? (e.SalaryPrice ?? null) : null,

        // ✅ always send base64 string
        profileImage: profileImageBase64,
        profileImageMime: e.profileImageMime ?? "",
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

app.patch("/profile/employees", async (req, res) => {
  const { db, email, updates } = req.body;

  if (!db || !email || !updates || typeof updates !== "object") {
    return res.status(400).json({
      success: false,
      message: "db, email, and updates object are required",
    });
  }

  const oldEmail = String(email).trim();
  const newEmail = updates.email != null ? String(updates.email).trim() : null;

  try {
    const pool = getPool(db);
    const conn = await pool.getConnection();

    try {
      const ALLOWED = new Set(["email", "phone", "address", "profileImage", "profileImageMime"]);

      const setParts = [];
      const values = [];

      for (const [k, v] of Object.entries(updates)) {
        if (!ALLOWED.has(k)) continue;

        // ✅ clearing image
        if ((k === "profileImage" || k === "profileImageMime") && (v === "" || v === null)) {
          setParts.push(`${k} = NULL`);
          continue;
        }

        // ✅ LONGBLOB: incoming base64 -> Buffer
        if (k === "profileImage") {
          if (typeof v !== "string") continue;
          const raw = v.trim();
          if (!raw) {
            setParts.push(`profileImage = NULL`);
            continue;
          }

          // supports "data:image/...;base64,...." too
          const clean = raw.includes(",") ? raw.split(",").pop().trim() : raw;
          const buf = Buffer.from(clean, "base64");

          setParts.push(`profileImage = ?`);
          values.push(buf);
          continue;
        }

        setParts.push(`${k} = ?`);
        values.push(v);
      }

      if (!setParts.length) {
        conn.release();
        return res.status(400).json({ success: false, message: "No allowed fields to update" });
      }

      await conn.beginTransaction();

      // 1) Employees (current DB)
      values.push(oldEmail);
      const sqlEmployees = `UPDATE Employees SET ${setParts.join(", ")} WHERE email = ? LIMIT 1`;
      const [empResult] = await conn.query(sqlEmployees, values);

      if (!empResult.affectedRows) {
        await conn.rollback();
        conn.release();
        return res.status(404).json({ success: false, message: "Employee not found" });
      }

      // 2) If email changed -> update Users in current DB + yassir_access
      const emailChanged =
        newEmail && newEmail.length > 3 && newEmail.toLowerCase() !== oldEmail.toLowerCase();

      if (emailChanged) {
        await conn.query(`UPDATE Users SET email = ? WHERE email = ?`, [newEmail, oldEmail]);
        await conn.query(`UPDATE yassir_access.Users SET email = ? WHERE email = ?`, [newEmail, oldEmail]);
      }

      await conn.commit();
      conn.release();

      return res.json({ success: true, message: "Profile updated" });
    } catch (err) {
      try { await conn.rollback(); } catch (_) {}
      conn.release();

      if (String(err.code) === "ER_DUP_ENTRY") {
        return res.status(409).json({ success: false, message: "Email already exists" });
      }

      console.error(err);
      return res.status(500).json({ success: false, message: "Server error", error: err.message });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// Get current week's rota
app.get("/rota", async (req, res) => {
  const { db, name, lastName } = req.query;
  if (!db || !name || !lastName)
    return res.status(400).json({ success: false, message: "Database, name, and lastName required" });

  try {
    const pool = getPool(db);

    const query = `
      SELECT id, name, lastName, day, startTime, endTime, designation, wage
      FROM rota
      WHERE name = ? AND lastName = ?
        AND STR_TO_DATE(day, '%d/%m/%Y') BETWEEN
            DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)
            AND DATE_ADD(DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY), INTERVAL 6 DAY)
      ORDER BY STR_TO_DATE(day, '%d/%m/%Y'), startTime
    `;

    const [rows] = await pool.query(query, [name, lastName]);

    const formattedRows = rows.map(row => ({
      ...row,
      startTime: row.startTime ? row.startTime.substring(0, 5) : '',
      endTime: row.endTime ? row.endTime.substring(0, 5) : ''
    }));

    return res.json(formattedRows);
  } catch (err) {
    console.error("Error fetching current week rota:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Get all rota entries for a specific week with designation (only published shifts)
app.get("/all-rota", async (req, res) => {
  const { db, startDate, endDate } = req.query;
  
  if (!db || !startDate || !endDate) {
    return res.status(400).json({ 
      success: false, 
      message: "Database, startDate, and endDate are required" 
    });
  }

  try {
    const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
    if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid date format. Use dd/mm/yyyy" 
      });
    }
    
    const pool = getPool(db);
    
    const [startDay, startMonth, startYear] = startDate.split('/');
    const [endDay, endMonth, endYear] = endDate.split('/');
    
    const startDateSQL = `${startYear}-${startMonth}-${startDay}`;
    const endDateSQL = `${endYear}-${endMonth}-${endDay}`;
    
    const query = `
      SELECT 
        r.name,
        r.lastName,
        r.day,
        TIME_FORMAT(r.startTime, '%H:%i') as startTime,
        TIME_FORMAT(r.endTime, '%H:%i') as endTime,
        COALESCE(e.designation, 'Unknown') as designation
      FROM rota r
      LEFT JOIN Employees e ON r.name = e.name AND r.lastName = e.lastName
      WHERE r.Published = 'Published'
        AND STR_TO_DATE(SUBSTRING_INDEX(r.day, ' (', 1), '%d/%m/%Y') 
            BETWEEN ? AND ?
      ORDER BY 
        CASE WHEN COALESCE(e.designation, '') = 'BOH' THEN 1 
             WHEN COALESCE(e.designation, '') = 'FOH' THEN 2 
             ELSE 3 END,
        r.lastName,
        r.name,
        STR_TO_DATE(SUBSTRING_INDEX(r.day, ' (', 1), '%d/%m/%Y'),
        r.startTime
    `;
    
    const [rows] = await pool.query(query, [startDateSQL, endDateSQL]);
    
    const formattedData = rows
      .filter(row => row.startTime && row.endTime && row.startTime.trim() !== '' && row.endTime.trim() !== '')
      .map(row => ({
        name: row.name || '',
        lastName: row.lastName || '',
        day: row.day || '',
        startTime: row.startTime ? row.startTime.substring(0, 5) : '',
        endTime: row.endTime ? row.endTime.substring(0, 5) : '',
        designation: row.designation || 'Unknown'
      }));
    
    return res.json(formattedData);
    
  } catch (err) {
    console.error("Error fetching all rota:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Server error fetching rota data",
      error: err.message 
    });
  }
});

// Get confirmed rota
app.get("/confirmedRota", async (req, res) => {
  const { db, name, lastName, month, year } = req.query;

  if (!db || !name || !lastName)
    return res.status(400).json({ success: false, message: "Database, name, and lastName required" });

  try {
    const pool = getPool(db);

    let query = `
      SELECT id, name, lastName, day, startTime, endTime, designation, wage
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

    query += ` ORDER BY STR_TO_DATE(day, '%d/%m/%Y'), startTime`;

    const [rows] = await pool.query(query, params);

    const formattedRows = rows.map(row => ({
      ...row,
      startTime: row.startTime ? row.startTime.substring(0, 5) : '',
      endTime: row.endTime ? row.endTime.substring(0, 5) : ''
    }));

    return res.json(formattedRows);
  } catch (err) {
    console.error("Error fetching confirmed rota:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Get today's shifts
app.get("/today-shifts", async (req, res) => {
  const { db, email } = req.query;
  
  if (!db || !email) {
    return res.status(400).json({ 
      success: false, 
      message: "Database and email are required" 
    });
  }

  try {
    const pool = getPool(db);
    
    const [employeeRows] = await pool.query(
      "SELECT name, lastName, wage, designation FROM Employees WHERE email = ?",
      [email]
    );
    
    if (!employeeRows || employeeRows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: "Employee not found" 
      });
    }
    
    const employee = employeeRows[0];
    const { name, lastName, wage, designation } = employee;
    
    const today = new Date();
    const day = `${String(today.getDate()).padStart(2, '0')}/${
      String(today.getMonth() + 1).padStart(2, '0')}/${
      today.getFullYear()}`;
    
    const [shiftRows] = await pool.query(
      `SELECT id, name, lastName, day, startTime, endTime, designation, wage 
       FROM rota 
       WHERE name = ? AND lastName = ? AND day = ?
       ORDER BY startTime ASC`,
      [name, lastName, day]
    );
    
    const formattedShifts = shiftRows.map(shift => ({
      ...shift,
      startTime: shift.startTime ? shift.startTime.substring(0, 5) : '',
      endTime: shift.endTime ? shift.endTime.substring(0, 5) : ''
    }));
    
    return res.json({
      success: true,
      employee: { 
        name, 
        lastName, 
        wage: wage ? parseFloat(wage) : 0,
        designation: designation || ''
      },
      today: day,
      shifts: formattedShifts
    });
    
  } catch (err) {
    console.error("Error fetching today's shifts:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Server error fetching shifts" 
    });
  }
});

// Save or update a specific shift
app.post("/save-shift", async (req, res) => {
  const { db, entryId, name, lastName, day, startTime, endTime, wage, designation } = req.body;
  
  if (!db || !name || !lastName || !day || !startTime || !endTime) {
    return res.status(400).json({ 
      success: false, 
      message: "Database, name, lastName, day, startTime, and endTime are required" 
    });
  }

  try {
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
      return res.status(400).json({ 
        success: false, 
        message: "Time must be in HH:mm format" 
      });
    }
    
    const [startHour, startMin] = startTime.split(':').map(Number);
    const [endHour, endMin] = endTime.split(':').map(Number);

    if (startHour < 0 || startHour > 23 || startMin < 0 || startMin > 59 ||
        endHour < 0 || endHour > 23 || endMin < 0 || endMin > 59) {
      return res.status(400).json({ 
        success: false, 
        message: "Times must be valid (HH: 0-23, MM: 0-59)" 
      });
    }
    
    const pool = getPool(db);
    
    const [existingShifts] = await pool.query(
      `SELECT id, startTime, endTime FROM rota 
       WHERE name = ? AND lastName = ? AND day = ?`,
      [name, lastName, day]
    );
    
    const newStartMin = startHour * 60 + startMin;
    const newEndMin = endHour * 60 + endMin;
    
    for (const existing of existingShifts) {
      if (entryId && existing.id == entryId) continue;
      
      const existingStart = existing.startTime.substring(0, 5);
      const existingEnd = existing.endTime.substring(0, 5);
      
      const [existingStartHour, existingStartMinute] = existingStart.split(':').map(Number);
      const [existingEndHour, existingEndMinute] = existingEnd.split(':').map(Number);
      
      const existingStartTotal = existingStartHour * 60 + existingStartMinute;
      const existingEndTotal = existingEndHour * 60 + existingEndMinute;
      
      let overlap = false;
      
      if (newStartMin < newEndMin && existingStartTotal < existingEndTotal) {
        overlap = (newStartMin < existingEndTotal && newEndMin > existingStartTotal);
      }
      else if (newStartMin > newEndMin) {
        const newEndMinNextDay = newEndMin + 1440;
        if (existingStartTotal < existingEndTotal) {
          overlap = (newStartMin < existingEndTotal || newEndMinNextDay > existingStartTotal);
        } else {
          const existingEndTotalNextDay = existingEndTotal + 1440;
          overlap = (newStartMin < existingEndTotalNextDay && newEndMinNextDay > existingStartTotal);
        }
      }
      else if (existingStartTotal > existingEndTotal) {
        const existingEndTotalNextDay = existingEndTotal + 1440;
        overlap = (newStartMin < existingEndTotalNextDay && newEndMin > existingStartTotal);
      }
      
      if (overlap) {
        return res.status(400).json({ 
          success: false, 
          message: "This shift overlaps with another existing shift" 
        });
      }
    }
    
    const startTimeWithSeconds = ensureTimeWithSeconds(startTime);
    const endTimeWithSeconds = ensureTimeWithSeconds(endTime);
    
    if (entryId) {
      // UPDATE existing shift - set ConfirmedByTM to 'yes'
      await pool.query(
        `UPDATE rota 
         SET startTime = ?, endTime = ?, wage = ?, designation = ?, ConfirmedByTM = 'yes'
         WHERE id = ?`,
        [startTimeWithSeconds, endTimeWithSeconds, wage || 0, designation || '', entryId]
      );
      
      return res.json({ 
        success: true, 
        message: "Shift updated successfully",
        entryId: entryId
      });
    } else {
      if (existingShifts.length >= 2) {
        return res.status(400).json({ 
          success: false, 
          message: "Maximum 2 shifts per day already exist" 
        });
      }
      
      let uniqueId;
      let codeExists = true;
      let attempts = 0;
      
      while (codeExists && attempts < 10) {
        uniqueId = generateUniqueCode();
        const [existingCode] = await pool.query(
          `SELECT id FROM rota WHERE id = ?`,
          [uniqueId]
        );
        codeExists = existingCode.length > 0;
        attempts++;
      }
      
      if (codeExists) {
        return res.status(500).json({ 
          success: false, 
          message: "Could not generate unique shift code" 
        });
      }
      
      // INSERT new shift - set ConfirmedByTM to 'yes'
      await pool.query(
        `INSERT INTO rota (id, name, lastName, day, startTime, endTime, wage, designation, ConfirmedByTM) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'yes')`,
        [uniqueId, name, lastName, day, startTimeWithSeconds, endTimeWithSeconds, 
         wage || 0, designation || '']
      );
      
      return res.json({ 
        success: true, 
        message: "Shift saved successfully",
        entryId: uniqueId
      });
    }
    
  } catch (err) {
    console.error("Error saving shift:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Server error saving shift" 
    });
  }
});

// Delete a specific shift
app.post("/delete-shift", async (req, res) => {
  const { db, entryId } = req.body;
  
  if (!db || !entryId) {
    return res.status(400).json({ 
      success: false, 
      message: "Database and entryId are required" 
    });
  }

  try {
    const pool = getPool(db);
    
    const [result] = await pool.query(
      `DELETE FROM rota WHERE id = ?`,
      [entryId]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ 
        success: false, 
        message: "Shift not found" 
      });
    }
    
    return res.json({ 
      success: true, 
      message: "Shift deleted successfully" 
    });
    
  } catch (err) {
    console.error("Error deleting shift:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Server error deleting shift" 
    });
  }
});

// DELETE method for shift deletion
app.delete("/delete-shift", async (req, res) => {
  const { db, entryId } = req.body;
  
  if (!db || !entryId) {
    return res.status(400).json({ 
      success: false, 
      message: "Database and entryId are required" 
    });
  }

  try {
    const pool = getPool(db);
    
    const [result] = await pool.query(
      `DELETE FROM rota WHERE id = ?`,
      [entryId]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ 
        success: false, 
        message: "Shift not found" 
      });
    }
    
    return res.json({ 
      success: true, 
      message: "Shift deleted successfully" 
    });
    
  } catch (err) {
    console.error("Error deleting shift:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Server error deleting shift" 
    });
  }
});

// Add another shift
app.post("/add-another-shift", async (req, res) => {
  const { db, name, lastName, day, startTime, endTime, wage, designation } = req.body;
  
  if (!db || !name || !lastName || !day || !startTime || !endTime) {
    return res.status(400).json({ 
      success: false, 
      message: "All fields are required" 
    });
  }

  try {
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
      return res.status(400).json({ 
        success: false, 
        message: "Time must be in HH:mm format" 
      });
    }
    
    const [startHour, startMin] = startTime.split(':').map(Number);
    const [endHour, endMin] = endTime.split(':').map(Number);

    if (startHour < 0 || startHour > 23 || startMin < 0 || startMin > 59 ||
        endHour < 0 || endHour > 23 || endMin < 0 || endMin > 59) {
      return res.status(400).json({ 
        success: false, 
        message: "Times must be valid (HH: 0-23, MM: 0-59)" 
      });
    }
    
    const pool = getPool(db);
    
    const [countRows] = await pool.query(
      `SELECT COUNT(*) as count FROM rota 
       WHERE name = ? AND lastName = ? AND day = ?`,
      [name, lastName, day]
    );
    
    if (countRows[0].count >= 2) {
      return res.status(400).json({ 
        success: false, 
        message: "Maximum 2 shifts per day already exist" 
      });
    }
    
    const [existingShifts] = await pool.query(
      `SELECT startTime, endTime FROM rota 
       WHERE name = ? AND lastName = ? AND day = ?
       ORDER BY startTime ASC`,
      [name, lastName, day]
    );
    
    for (const existing of existingShifts) {
      const existingStart = existing.startTime.substring(0, 5);
      const existingEnd = existing.endTime.substring(0, 5);
      
      if (
        (startTime < existingEnd && endTime > existingStart) ||
        (endTime > existingStart && startTime < existingEnd)
      ) {
        return res.status(400).json({ 
          success: false, 
          message: "New shift overlaps with existing shift" 
        });
      }
    }
    
    let uniqueId;
    let codeExists = true;
    let attempts = 0;
    
    while (codeExists && attempts < 10) {
      uniqueId = generateUniqueCode();
      const [existingCode] = await pool.query(
        `SELECT id FROM rota WHERE id = ?`,
        [uniqueId]
      );
      codeExists = existingCode.length > 0;
      attempts++;
    }
    
    if (codeExists) {
      return res.status(500).json({ 
        success: false, 
        message: "Could not generate unique shift code" 
      });
    }
    
    const startTimeWithSeconds = ensureTimeWithSeconds(startTime);
    const endTimeWithSeconds = ensureTimeWithSeconds(endTime);
    
    await pool.query(
      `INSERT INTO rota (id, name, lastName, day, startTime, endTime, wage, designation) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uniqueId, name, lastName, day, startTimeWithSeconds, endTimeWithSeconds, 
       wage || 0, designation || '']
    );
    
    return res.json({ 
      success: true, 
      message: "Shift added successfully",
      id: uniqueId 
    });
    
  } catch (err) {
    console.error("Error adding shift:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Server error adding shift" 
    });
  }
});

// Holidays endpoint
app.get("/holidays", async (req, res) => {
  const { db, email, yearStart, yearEnd } = req.query;

  if (!db || !email) {
    return res.status(400).json({ success: false, message: "Database and email are required" });
  }

  try {
    const pool = getPool(db);

    // 1) Employee
    const [employeeRows] = await pool.query(
      "SELECT name, lastName, startHoliday FROM Employees WHERE email = ? LIMIT 1",
      [email]
    );

    if (!employeeRows.length) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    const { name, lastName } = employeeRows[0];
    const allowanceDays = Number(employeeRows[0].startHoliday ?? 0) || 0;

    // 2) Determine year window
    let selectedYearStart = null;
    let selectedYearEnd = null;

    if (yearStart && yearEnd) {
      selectedYearStart = yearStart;
      selectedYearEnd = yearEnd;
    } else {
      // current year from settings
      const [currentYearRows] = await pool.query(`
        SELECT HolidayYearStart AS start, HolidayYearEnd AS end
        FROM HolidayYearSettings
        WHERE CURDATE() BETWEEN HolidayYearStart AND HolidayYearEnd
        LIMIT 1
      `);

      if (!currentYearRows.length) {
        return res.json({
          success: true,
          employee: { name, lastName, allowanceDays },
          year: null,
          summary: null,
          approvedHolidays: [],
          pendingHolidays: [],
          declinedHolidays: [],
        });
      }

      selectedYearStart = currentYearRows[0].start;
      selectedYearEnd = currentYearRows[0].end;
    }

    // 3) Helpers
    const startDateSql = `STR_TO_DATE(SUBSTRING_INDEX(startDate, ' ', 1), '%d/%m/%Y')`;
    const requestDateSql = `STR_TO_DATE(SUBSTRING_INDEX(requestDate, ' ', 1), '%d/%m/%Y')`;

    // accrual for this year only
    const calcAccrued = (ys, ye) => {
      if (!allowanceDays) return 0;

      const today = new Date();
      const yStart = new Date(ys);
      const yEnd = new Date(ye);

      yStart.setHours(0, 0, 0, 0);
      yEnd.setHours(23, 59, 59, 999);

      if (today < yStart) return 0;
      if (today > yEnd) return allowanceDays;

      const msPerDay = 86400000;
      const totalDays = Math.floor((yEnd - yStart) / msPerDay) + 1;
      const elapsedDays = Math.floor((today - yStart) / msPerDay) + 1;

      return Math.min(allowanceDays, (allowanceDays * elapsedDays) / totalDays);
    };

    const normalizeRow = (row) => {
      const acceptedRaw = (row.accepted ?? "").toString().trim().toLowerCase();
      const who = (row.who ?? "").toString();
      const isApproved = who.trim() !== "";
      const isUnpaid = acceptedRaw === "unpaid";
      const isDeclined = acceptedRaw === "false";

      const type = isUnpaid ? "Unpaid" : "Paid";

      let status = "Pending";
      if (isDeclined) status = "Declined";
      else if (isApproved) status = isUnpaid ? "Approved (Unpaid)" : "Approved (Paid)";

      return {
        startDate: row.startDate ?? "",
        endDate: row.endDate ?? "",
        requestDate: row.requestDate ?? "",
        days: Number(row.days ?? 0) || 0,
        who: who ?? "",
        notes: row.notes ?? "",
        status,
        type,
      };
    };

    // 4) Pull only holidays in the selected year (based on startDate)
    const [rows] = await pool.query(
      `
      SELECT *
      FROM Holiday
      WHERE name = ? AND lastName = ?
      AND ${startDateSql} BETWEEN ? AND ?
      ORDER BY ${requestDateSql} DESC
      `,
      [name, lastName, selectedYearStart, selectedYearEnd]
    );

    // 5) Split lists + totals
    const pending = [];
    const approved = [];
    const declined = [];

    let takenPaid = 0;
    let takenUnpaid = 0;
    let pendingPaid = 0;
    let pendingUnpaid = 0;
    let declinedDays = 0;

    for (const r of rows) {
      const item = normalizeRow(r);
      const d = item.days || 0;

      if (item.status.toLowerCase().startsWith("approved")) {
        approved.push(item);
        if (item.type.toLowerCase() === "paid") takenPaid += d;
        else takenUnpaid += d;
      } else if (item.status.toLowerCase() === "declined") {
        declined.push(item);
        declinedDays += d;
      } else {
        pending.push(item);
        if (item.type.toLowerCase() === "paid") pendingPaid += d;
        else pendingUnpaid += d;
      }
    }

    const accrued = Number(calcAccrued(selectedYearStart, selectedYearEnd).toFixed(2));
    const remainingYear = Math.max(0, allowanceDays - takenPaid);
    const availableNow = Math.max(0, Math.min(accrued, allowanceDays) - takenPaid);

    res.json({
      success: true,
      employee: { name, lastName, allowanceDays },
      year: { start: selectedYearStart, end: selectedYearEnd },
      summary: {
        allowanceDays,
        accruedDays: accrued,
        takenPaidDays: takenPaid,
        takenUnpaidDays: takenUnpaid,
        pendingPaidDays: pendingPaid,
        pendingUnpaidDays: pendingUnpaid,
        declinedDays,
        remainingYearDays: Number(remainingYear.toFixed(2)),
        availableNowDays: Number(availableNow.toFixed(2)),
      },
      approvedHolidays: approved,
      pendingHolidays: pending,
      declinedHolidays: declined,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// Holiday Request endpoint
app.post("/holidays/request", async (req, res) => {
  const { db, email, startDate, endDate, notes = "", type = "Paid" } = req.body;

  if (!db || !email || !startDate || !endDate) {
    return res.status(400).json({
      success: false,
      message: "db, email, startDate and endDate are required",
    });
  }

  try {
    const pool = getPool(db);

    const [employeeRows] = await pool.query(
      "SELECT name, lastName FROM Employees WHERE email = ?",
      [email]
    );

    if (!employeeRows || employeeRows.length === 0) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    const employee = employeeRows[0];

    const parseToUTCDate = (input) => {
      const s = String(input).trim();
      const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
      if (m) {
        const dd = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        const yyyy = parseInt(m[3], 10);
        return new Date(Date.UTC(yyyy, mm - 1, dd));
      }
      const d = new Date(s);
      if (isNaN(d.getTime())) return null;
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    };

    const sUTC = parseToUTCDate(startDate);
    const eUTC = parseToUTCDate(endDate);

    if (!sUTC || !eUTC) {
      return res.status(400).json({ success: false, message: "Invalid date format" });
    }

    const diff = Math.round((eUTC - sUTC) / (1000 * 60 * 60 * 24)) + 1;
    if (diff <= 0) {
      return res.status(400).json({ success: false, message: "Invalid holiday period" });
    }

    const acceptedValue = String(type).toLowerCase() === "unpaid" ? "unpaid" : "";

    const formattedStart = formatDateWithDay(startDate);
    const formattedEnd = formatDateWithDay(endDate);

    const requestDate = new Date();

    await pool.query(
      `INSERT INTO Holiday 
        (name, lastName, startDate, endDate, requestDate, days, accepted, who, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        employee.name,
        employee.lastName,
        formattedStart,
        formattedEnd,
        requestDate,
        diff,
        acceptedValue,
        "",
        notes,
      ]
    );

    const title = "New Holiday Request";
    const message =
      `${employee.name} ${employee.lastName} requested holiday from ` +
      `${formattedStart} to ${formattedEnd} (${diff} days) - ${type}`;

    await pool.query(
      `INSERT INTO Notifications (targetRole, title, message, type)
       VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
      ["AM", title, message, "HOLIDAY", "Manager", title, message, "HOLIDAY"]
    );

    return res.json({ success: true, message: "Holiday request submitted" });
  } catch (err) {
    console.error("Error requesting holiday:", err);
    return res.status(500).json({
      success: false,
      message: "Server error requesting holiday",
      error: err.message,
    });
  }
});

// Get pending holiday requests
app.get("/holidays/pending", async (req, res) => {
  const { db } = req.query;

  if (!db) {
    return res.status(400).json({ success: false, message: "db is required" });
  }

  try {
    const pool = getPool(db);

    const [rows] = await pool.query(
      `SELECT id, name, lastName, startDate, endDate, requestDate, days, accepted, who, notes
       FROM Holiday
       WHERE (accepted IS NULL OR accepted = '' OR accepted = 'unpaid')
       ORDER BY requestDate DESC`
    );

    return res.json({ success: true, holidays: rows });
  } catch (err) {
    console.error("Error fetching pending holidays:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// Holiday Decision endpoint
app.post("/holidays/decide", async (req, res) => {
  const { db, id, decision, actorEmail, reason = "" } = req.body;

  if (!db || !id || !decision || !actorEmail) {
    return res.status(400).json({
      success: false,
      message: "db, id, decision, actorEmail are required",
    });
  }

  const dec = String(decision).trim().toLowerCase();
  if (dec !== "approve" && dec !== "decline") {
    return res.status(400).json({
      success: false,
      message: "decision must be 'approve' or 'decline'",
    });
  }

  try {
    const tenantPool = getPool(db);

    const [userRows] = await pool.query(
      `SELECT Access 
       FROM users 
       WHERE Email = ? AND db_name = ?`,
      [actorEmail.trim(), db]
    );

    if (!userRows || userRows.length === 0) {
      return res.status(403).json({
        success: false,
        message: "Not allowed (no access for this database)",
      });
    }

    const accessList = userRows.map(r => String(r.Access || "").trim().toLowerCase());
    const isApprover = accessList.some(a => a === "am" || a === "manager");

    if (!isApprover) {
      return res.status(403).json({
        success: false,
        message: "Not allowed",
      });
    }

    let who = actorEmail.trim();
    const [actorEmpRows] = await tenantPool.query(
      `SELECT name, lastName
       FROM Employees
       WHERE email = ?
       LIMIT 1`,
      [actorEmail.trim()]
    );

    if (actorEmpRows && actorEmpRows.length > 0) {
      const a = actorEmpRows[0];
      const full = `${a.name || ""} ${a.lastName || ""}`.trim();
      if (full) who = full;
    }

    const [holidayRows] = await tenantPool.query(
      `SELECT id, name, lastName, startDate, endDate, notes
       FROM Holiday
       WHERE id = ?
       LIMIT 1`,
      [id]
    );

    if (!holidayRows || holidayRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Holiday request not found",
      });
    }

    const holiday = holidayRows[0];

    const currentAccepted = String(holiday.accepted || "").trim().toLowerCase();
    const stillPendingOrUnpaid = currentAccepted === "" || currentAccepted === "unpaid";

    if (!stillPendingOrUnpaid) {
      return res.status(409).json({
        success: false,
        message: "This request was already decided",
      });
    }

    const acceptedValue = dec === "approve" ? "true" : "false";
    const declineReason = String(reason || "").trim();
    const updatedNotes = dec === "decline" && declineReason ? declineReason : (holiday.notes || "");

    await tenantPool.query(
      `UPDATE Holiday
       SET accepted = ?, who = ?, notes = ?
       WHERE id = ?`,
      [acceptedValue, who, updatedNotes, id]
    );

    const title = dec === "approve" ? "Holiday Approved" : "Holiday Declined";
    const msg =
      dec === "approve"
        ? `${holiday.name} ${holiday.lastName} holiday approved (${holiday.startDate} → ${holiday.endDate}) by ${who}`
        : `${holiday.name} ${holiday.lastName} holiday declined (${holiday.startDate} → ${holiday.endDate}) by ${who}${declineReason ? ` | Reason: ${declineReason}` : ""}`;

    await tenantPool.query(
      `INSERT INTO Notifications (targetRole, title, message, type)
       VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
      ["AM", title, msg, "HOLIDAY", "Manager", title, msg, "HOLIDAY"]
    );

    return res.json({ success: true, message: "Decision saved" });
  } catch (err) {
    console.error("Error deciding holiday:", err);
    return res.status(500).json({
      success: false,
      message: "Server error deciding holiday",
      error: err.message,
    });
  }
});

// ==================== NOTIFICATIONS ENDPOINTS ====================

app.post('/send-notification', async (req, res) => {
    try {
        const { userId, email, name, title, body, data, dbName } = req.body;

        console.log("=================================");
        console.log("📱 INVIO NOTIFICA PUSH");
        console.log("=================================");
        console.log(`📧 Email: ${email}`);
        console.log(`📝 Title: ${title}`);
        console.log(`💬 Body: ${body}`);
        console.log(`💾 Database: ${dbName}`);
        console.log(`📊 Data:`, data);
        console.log("=================================");

        if (!dbName) {
            return res.status(400).json({ 
                success: false, 
                message: 'Database name is required' 
            });
        }

        // Ottieni il pool per il database specifico
        const userPool = getPool(dbName);
        const queryPool = userPool.promise ? userPool.promise() : userPool;

        // LOG: Cerca i token
        console.log(`🔍 Cerco token per email: ${email}`);
        const [userTokens] = await queryPool.query(
            `SELECT fcm_token, device_type 
             FROM user_devices 
             WHERE email = ?`,
            [email]
        );

        console.log(`📊 Trovati ${userTokens.length} dispositivi:`);
        userTokens.forEach((t, i) => {
            console.log(`   ${i+1}. Tipo: ${t.device_type} | Token: ${t.fcm_token ? t.fcm_token.substring(0, 20) + '...' : 'MANCANTE'}`);
        });

        if (userTokens.length === 0) {
            console.log("❌ Nessun dispositivo trovato!");
            return res.status(404).json({ 
                success: false, 
                message: 'No device tokens found for user' 
            });
        }

        // Invia notifiche push
        console.log("📱 Invio notifiche FCM...");
        const fcmPromises = userTokens.map(async (device, index) => {
            if (!device.fcm_token) {
                console.log(`   ⚠️ Dispositivo ${index+1}: token mancante, salto...`);
                return Promise.reject(new Error('Token mancante'));
            }

            const message = {
                token: device.fcm_token,
                notification: { 
                    title, 
                    body 
                },
                data: {
                    type: data.type,
                    notificationSubtype: data.notificationSubtype,
                    timestamp: data.timestamp,
                    weekStart: data.weekStart || '',
                    weekEnd: data.weekEnd || '',
                    action: data.action || 'view_rota',
                    click_action: 'FLUTTER_NOTIFICATION_CLICK',
                },
                android: {
                    priority: 'high',
                    notification: {
                        sound: 'default',
                        channelId: 'rota_notifications',
                        clickAction: 'FLUTTER_NOTIFICATION_CLICK',
                    },
                },
                apns: {
                    payload: {
                        aps: {
                            sound: 'default',
                            badge: 1,
                        },
                    },
                },
            };

            console.log(`   📤 Invio a dispositivo ${index+1} (${device.device_type})...`);
            console.log(`      Token: ${device.fcm_token.substring(0, 30)}...`);
            
            try {
                const response = await admin.messaging().send(message);
                console.log(`   ✅ Successo! Response:`, response);
                return response;
            } catch (err) {
                console.log(`   ❌ Errore:`, err.message);
                if (err.code === 'messaging/registration-token-not-registered') {
                    // Token non valido, rimuovilo
                    await queryPool.query(
                        "DELETE FROM user_devices WHERE fcm_token = ?",
                        [device.fcm_token]
                    );
                    console.log(`   🗑️ Token rimosso dal database`);
                }
                throw err;
            }
        });

        const fcmResults = await Promise.allSettled(fcmPromises);
        
        const successCount = fcmResults.filter(r => r.status === 'fulfilled').length;
        console.log(`📊 Risultati: ${successCount}/${userTokens.length} notifiche inviate con successo`);

        // Salva la notifica nel database
        const [insertResult] = await queryPool.query(
            `INSERT INTO Notifications 
            (targetRole, title, message, type, postId, isRead, createdAt, targetEmail, authorEmail) 
            VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
            [
                data.role || 'EMPLOYEE',
                title,
                body,
                'SYSTEM',
                data.postId || null,
                0,
                email,
                'system@solura.com'
            ]
        );

        console.log(`✅ Notifica salvata in DB con ID: ${insertResult.insertId}`);

        res.json({ 
            success: true, 
            message: 'Notification sent successfully',
            deliveredCount: successCount,
            totalDevices: userTokens.length
        });
    } catch (error) {
        console.error('❌ ERRORE GENERALE:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error sending notification: ' + error.message 
        });
    }
});

// Send notification to specific user (database only)
app.post("/notifications/send", async (req, res) => {
  const { db, targetEmail, title, message, type, postId } = req.body;

  if (!db || !targetEmail || !title || !message) {
    return res.status(400).json({ 
      success: false, 
      message: "Missing required fields" 
    });
  }

  try {
    const pool = getPool(db);
    
    const [result] = await pool.query(
      `INSERT INTO Notifications 
       (targetEmail, targetRole, title, message, type, postId, isRead, createdAt) 
       VALUES (?, 'USER', ?, ?, ?, ?, 0, NOW())`,
      [targetEmail, title, message, type || 'info', postId || null]
    );

    res.json({ 
      success: true, 
      message: "Notification sent",
      notificationId: result.insertId 
    });

  } catch (err) {
    console.error("❌ Error sending notification:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Send notification to all users with a specific role
app.post("/notifications/send-to-role", async (req, res) => {
  const { db, targetRole, title, message, type, postId } = req.body;

  if (!db || !targetRole || !title || !message) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  try {
    const pool = getPool(db);
    
    const [result] = await pool.query(
      `INSERT INTO Notifications 
       (targetRole, title, message, type, postId, isRead, createdAt) 
       VALUES (?, ?, ?, ?, ?, 0, NOW())`,
      [targetRole, title, message, type || 'info', postId || null]
    );

    res.json({ 
      success: true, 
      message: `Notification sent to role: ${targetRole}`,
      notificationId: result.insertId 
    });

  } catch (err) {
    console.error("❌ Error sending notification to role:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Send notification with FCM push
app.post("/notifications/send-push", async (req, res) => {
  const { db, targetEmail, targetRole, title, message, type, postId } = req.body;

  console.log("=================================");
  console.log("📱 SEND PUSH NOTIFICATION");
  console.log("=================================");
  console.log("db:", db);
  console.log("targetEmail:", targetEmail);
  console.log("targetRole:", targetRole);
  console.log("title:", title);
  console.log("message:", message);
  console.log("type:", type);
  console.log("=================================");

  if (!db || !title || !message) {
    return res.status(400).json({ 
      success: false, 
      message: "Missing required fields" 
    });
  }

  try {
    const pool = getPool(db);
    
    // 1. Insert into database
    let notificationId;
    if (targetEmail) {
      const [result] = await pool.query(
        `INSERT INTO Notifications 
         (targetEmail, targetRole, title, message, type, postId, isRead, createdAt, authorEmail) 
         VALUES (?, ?, ?, ?, ?, ?, 0, NOW(), ?)`,
        [targetEmail, targetRole || 'USER', title, message, type || 'info', postId || null, 'system@solura.com']
      );
      notificationId = result.insertId;
      console.log(`✅ Notification saved in DB with ID: ${notificationId} for email: ${targetEmail}`);
    } else if (targetRole) {
      const [result] = await pool.query(
        `INSERT INTO Notifications 
         (targetRole, title, message, type, postId, isRead, createdAt, authorEmail) 
         VALUES (?, ?, ?, ?, ?, 0, NOW(), ?)`,
        [targetRole, title, message, type || 'info', postId || null, 'system@solura.com']
      );
      notificationId = result.insertId;
      console.log(`✅ Notification saved in DB with ID: ${notificationId} for role: ${targetRole}`);
    }

    // 2. Get FCM tokens for target users
    let tokens = [];
    
    // 🔥 CASO SPECIALE: INVIO A TUTTI
    if (targetRole === 'ALL') {
      console.log('🔍 Sending notification to ALL devices');
      const [allDevices] = await pool.query(
        `SELECT fcm_token, device_type, email FROM user_devices WHERE fcm_token IS NOT NULL AND fcm_token != ''`
      );
      console.log(`📊 Found ${allDevices.length} total devices`);
      allDevices.forEach((row, i) => {
        console.log(`   Device ${i+1}: email=${row.email}, type=${row.device_type}, token=${row.fcm_token ? row.fcm_token.substring(0, 20) + '...' : 'NO TOKEN'}`);
      });
      tokens = allDevices.map(row => row.fcm_token).filter(t => t && t.length > 0);
      
    } else if (targetEmail) {
      // Get token for specific user
      console.log(`🔍 Looking for devices with email: ${targetEmail}`);
      const [rows] = await pool.query(
        `SELECT fcm_token, device_type FROM user_devices WHERE email = ?`,
        [targetEmail]
      );
      
      console.log(`📊 Found ${rows.length} devices for ${targetEmail}`);
      rows.forEach((row, i) => {
        console.log(`   Device ${i+1}: type=${row.device_type}, token=${row.fcm_token ? row.fcm_token.substring(0, 20) + '...' : 'NO TOKEN'}`);
      });
      
      tokens = rows.map(row => row.fcm_token).filter(t => t && t.length > 0);
      
    } else if (targetRole) {
      // Get tokens for all users with this role
      console.log(`🔍 Looking for devices for role: ${targetRole}`);
      
      // Prova a cercare in diverse tabelle possibili
      let userRows = [];
      
      // Prova nella tabella users
      try {
        const [rows] = await pool.query(
          `SELECT email FROM users WHERE role = ? OR access = ? OR UPPER(role) = UPPER(?) OR UPPER(access) = UPPER(?)`,
          [targetRole, targetRole, targetRole, targetRole]
        );
        userRows = rows;
      } catch (e) {
        console.log('⚠️ Error querying users table:', e.message);
      }
      
      // Se non trova nella tabella users, prova nella tabella Employees
      if (userRows.length === 0) {
        try {
          const [rows] = await pool.query(
            `SELECT email FROM Employees WHERE designation = ? OR UPPER(designation) = UPPER(?)`,
            [targetRole, targetRole]
          );
          userRows = rows;
          console.log(`📊 Found ${userRows.length} employees with designation ${targetRole}`);
        } catch (e) {
          console.log('⚠️ Error querying Employees table:', e.message);
        }
      }
      
      console.log(`📊 Found ${userRows.length} users with role ${targetRole}`);
      
      if (userRows.length > 0) {
        const emails = userRows.map(u => u.email);
        
        // Poi trova i dispositivi per queste email
        const [deviceRows] = await pool.query(
          `SELECT fcm_token, device_type, email FROM user_devices WHERE email IN (?) AND fcm_token IS NOT NULL AND fcm_token != ''`,
          [emails]
        );
        
        console.log(`📊 Found ${deviceRows.length} devices for these users`);
        deviceRows.forEach((row, i) => {
          console.log(`   Device ${i+1}: email=${row.email}, type=${row.device_type}, token=${row.fcm_token ? row.fcm_token.substring(0, 20) + '...' : 'NO TOKEN'}`);
        });
        
        tokens = deviceRows.map(row => row.fcm_token).filter(t => t && t.length > 0);
      } else {
        console.log(`⚠️ No users found with role ${targetRole}`);
      }
    }

    console.log(`📱 Total valid tokens to send: ${tokens.length}`);

    // 3. Send FCM push notifications
    if (tokens.length > 0) {
      console.log(`📤 Sending push notifications to ${tokens.length} devices...`);
      
      const fcmResults = [];
      
      for (const token of tokens) {
        try {
          const result = await sendFCMNotification(token, {
            title,
            body: message,
            data: {
              type: type || 'info',
              notificationId: notificationId?.toString() || '',
              postId: postId?.toString() || '',
              click_action: 'FLUTTER_NOTIFICATION_CLICK',
            }
          });
          
          console.log(`✅ FCM sent to ${token.substring(0, 20)}...`);
          fcmResults.push({ token: token.substring(0, 20) + '...', success: true });
          
        } catch (error) {
          console.error(`❌ FCM error for token ${token.substring(0, 20)}...:`, error.message);
          fcmResults.push({ token: token.substring(0, 20) + '...', success: false, error: error.message });
          
          // Se il token non è più valido, rimuovilo dal database
          if (error.code === 'messaging/registration-token-not-registered') {
            console.log(`   🗑️ Removing invalid token from database`);
            await pool.query(
              "DELETE FROM user_devices WHERE fcm_token = ?",
              [token]
            );
          }
        }
      }
      
      console.log("📊 FCM Results:", fcmResults);
      
    } else {
      console.log("⚠️ No valid tokens found to send notifications");
    }

    res.json({ 
      success: true, 
      message: "Push notification processed",
      notificationId,
      tokensFound: tokens.length,
      tokensSent: tokens.length,
      targetAll: targetRole === 'ALL'
    });

  } catch (err) {
    console.error("❌ Error sending push notification:", err);
    res.status(500).json({ 
      success: false, 
      message: "Server error",
      error: err.message 
    });
  }
});

// Helper function to send FCM notification
async function sendFCMNotification(token, { title, body, data }) {
  const message = {
    token: token,
    notification: {
      title: title,
      body: body,
    },
    data: {
      ...data,
      title: title, // Include for data-only messages
      body: body,
    },
    android: {
      priority: 'high',
      notification: {
        channelId: 'high_importance_channel',
        clickAction: 'FLUTTER_NOTIFICATION_CLICK',
      },
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
          badge: 1,
        },
      },
    },
  };

  try {
    const response = await admin.messaging().send(message);
    console.log('✅ FCM sent:', response);
    return response;
  } catch (error) {
    console.error('❌ FCM error:', error);
    throw error;
  }
}

// Get notifications
app.get("/notifications", async (req, res) => {
  const { db, role, userEmail } = req.query;

  if (!db) {
    return res.status(400).json({ success: false, message: "db is required" });
  }

  try {
    const pool = getPool(db);
    
    let query = `
      SELECT id, targetRole, targetEmail, authorEmail, title, message, type, 
             isRead, postId, createdAt
      FROM Notifications 
      WHERE 1=1
    `;
    const params = [];

    // ✅ CORREZIONE: Raggruppa le condizioni con le parentesi
    if (role && userEmail) {
      // Se abbiamo sia ruolo che email: (targetRole = ? OR targetRole = 'ALL' OR targetEmail = ?)
      query += ` AND (targetRole = ? OR targetRole = 'ALL' OR targetEmail = ?)`;
      params.push(role, userEmail);
    } else if (role) {
      // Solo ruolo
      query += ` AND (targetRole = ? OR targetRole = 'ALL')`;
      params.push(role);
    } else if (userEmail) {
      // Solo email
      query += ` AND targetEmail = ?`;
      params.push(userEmail);
    }

    query += ` ORDER BY id DESC LIMIT 50`;

    console.log("🔍 Notifications query:", query);
    console.log("🔍 Notifications params:", params);

    const [rows] = await pool.query(query, params);

    // Formatta le date per il frontend
    const notifications = rows.map(row => ({
      ...row,
      createdAt: row.createdAt ? row.createdAt.toISOString() : null
    }));

    console.log(`📊 Trovate ${notifications.length} notifiche`);

    res.json({ 
      success: true, 
      notifications 
    });

  } catch (err) {
    console.error("Error fetching notifications:", err);
    res.status(500).json({ 
      success: false, 
      message: "Server error fetching notifications",
      error: err.message 
    });
  }
});

// Get unread count - VERSIONE CORRETTA
app.get("/notifications/unread-count", async (req, res) => {
  const { db, role, userEmail } = req.query;

  if (!db) {
    return res.status(400).json({ success: false, message: "db is required" });
  }

  try {
    const pool = getPool(db);
    
    let query = `SELECT COUNT(*) as count FROM Notifications WHERE isRead = 0`;
    let params = [];

    // ✅ CORREZIONE: Stessa logica delle notifiche
    if (role && userEmail) {
      query += ` AND (targetRole = ? OR targetRole = 'ALL' OR targetEmail = ?)`;
      params.push(role, userEmail);
    } else if (role) {
      query += ` AND (targetRole = ? OR targetRole = 'ALL')`;
      params.push(role);
    } else if (userEmail) {
      query += ` AND targetEmail = ?`;
      params.push(userEmail);
    }

    console.log("🔍 Unread count query:", query);
    console.log("🔍 Unread count params:", params);

    const [result] = await pool.query(query, params);

    res.json({ 
      success: true, 
      count: result[0].count 
    });

  } catch (err) {
    console.error("Error fetching unread count:", err);
    res.status(500).json({ 
      success: false, 
      message: "Server error fetching unread count",
      error: err.message 
    });
  }
});

// Mark notification as read
app.post("/notifications/read", async (req, res) => {
  const { db, id } = req.body;

  if (!db || !id) {
    return res.status(400).json({ success: false, message: "db e id sono obbligatori" });
  }

  try {
    const pool = getPool(db);
    // AGGIUNTA LA WHERE CLAUSE!
    const [result] = await pool.query(
      "UPDATE Notifications SET isRead = 1 WHERE id = ?",
      [id]
    );

    console.log(`✅ Notifica ${id} segnata come letta. Righe aggiornate: ${result.affectedRows}`);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Errore nel segnare notifica come letta:", err);
    res.status(500).json({ success: false, message: "Errore server" });
  }
});

// Mark all notifications as read - VERSIONE CORRETTA (con gestione NULL)
app.post("/notifications/mark-all-read", async (req, res) => {
  const { db, role, userEmail } = req.body;

  if (!db) {
    return res.status(400).json({
      success: false,
      message: "db is required"
    });
  }

  try {
    const pool = getPool(db);
    
    console.log(`📝 Marking all as read for role: ${role}, email: ${userEmail}`);
    
    // Costruisci le condizioni per selezionare le notifiche DA AGGIORNARE
    let conditions = ["isRead = 0"]; // Solo notifiche non lette
    let params = [];

    // Condizioni per ruolo O email (con gestione CORRETTA di NULL)
    if (role && userEmail) {
      // Gestione speciale per targetEmail NULL
      conditions.push("(targetRole = ? OR targetRole = 'ALL' OR (targetEmail = ? OR targetEmail IS NULL))");
      params.push(role, userEmail);
    } else if (role) {
      conditions.push("(targetRole = ? OR targetRole = 'ALL')");
      params.push(role);
    } else if (userEmail) {
      conditions.push("(targetEmail = ? OR targetEmail IS NULL)");
      params.push(userEmail);
    }

    // Crea la query UPDATE con le condizioni
    const query = `UPDATE Notifications SET isRead = 1 WHERE ${conditions.join(' AND ')}`;
    
    console.log("🔍 Mark all query:", query);
    console.log("🔍 Mark all params:", params);

    const [result] = await pool.query(query, params);

    console.log(`✅ Marked ${result.affectedRows} notifications as read`);

    res.json({ 
      success: true, 
      message: "All notifications marked as read",
      markedCount: result.affectedRows 
    });

  } catch (err) {
    console.error("❌ Error marking all notifications as read:", err);
    res.status(500).json({
      success: false,
      message: "Server error marking all as read",
      error: err.message
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));