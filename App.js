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

// Helper function to generate unique 16-digit code
function generateUniqueCode() {
  // Generate 16-digit number
  const min = 1000000000000000; // 10^15
  const max = 9999999999999999; // 10^16 - 1
  return Math.floor(Math.random() * (max - min + 1)) + min;
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

// Get employee info by email (now includes wage and designation)
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

// Get current week's rota by employee name + lastName
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

    // Remove seconds from times for frontend display
    const formattedRows = rows.map(row => ({
      ...row,
      startTime: row.startTime ? row.startTime.substring(0, 5) : '', // HH:mm
      endTime: row.endTime ? row.endTime.substring(0, 5) : '' // HH:mm
    }));

    return res.json(formattedRows);
  } catch (err) {
    console.error("Error fetching current week rota:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Get all rota entries for a specific week with designation
app.get("/all-rota", async (req, res) => {
  const { db, startDate, endDate } = req.query;
  
  if (!db || !startDate || !endDate) {
    return res.status(400).json({ 
      success: false, 
      message: "Database, startDate, and endDate are required" 
    });
  }

  try {
    // Validate date format
    const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
    if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid date format. Use dd/mm/yyyy" 
      });
    }
    
    const pool = getPool(db);
    
    // Convert dates from dd/mm/yyyy to yyyy-mm-dd for SQL comparison
    const [startDay, startMonth, startYear] = startDate.split('/');
    const [endDay, endMonth, endYear] = endDate.split('/');
    
    const startDateSQL = `${startYear}-${startMonth}-${startDay}`;
    const endDateSQL = `${endYear}-${endMonth}-${endDay}`;
    
    console.log(`Fetching rota from ${startDate} to ${endDate}`);
    
    // Query to get all rota entries with employee designation
    // This assumes your rota table has columns: name, lastName, day, startTime, endTime
    // And employees table has: name, lastName, designation
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
      WHERE STR_TO_DATE(SUBSTRING_INDEX(r.day, ' (', 1), '%d/%m/%Y') 
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
    
    console.log(`Found ${rows.length} rota entries`);
    
    // Filter out entries with empty times and format the response
    const formattedData = rows
      .filter(row => row.startTime && row.endTime && row.startTime.trim() !== '' && row.endTime.trim() !== '')
      .map(row => ({
        name: row.name || '',
        lastName: row.lastName || '',
        day: row.day || '',
        startTime: row.startTime ? row.startTime.substring(0, 5) : '', // HH:mm format
        endTime: row.endTime ? row.endTime.substring(0, 5) : '', // HH:mm format
        designation: row.designation || 'Unknown'
      }));
    
    console.log(`Returning ${formattedData.length} valid entries`);
    
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

// Get confirmed rota with optional month/year filter
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

    // Remove seconds from times for frontend display
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

// Get today's shifts for an employee
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
    
    // 1. Get employee info from email (including wage and designation)
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
    
    // 2. Get today's date in dd/mm/yyyy format
    const today = new Date();
    const day = `${String(today.getDate()).padStart(2, '0')}/${
      String(today.getMonth() + 1).padStart(2, '0')}/${
      today.getFullYear()}`;
    
    // 3. Get today's shifts (max 2)
    const [shiftRows] = await pool.query(
      `SELECT id, name, lastName, day, startTime, endTime, designation, wage 
       FROM rota 
       WHERE name = ? AND lastName = ? AND day = ?
       ORDER BY startTime ASC`,
      [name, lastName, day]
    );
    
    // Remove seconds from times for frontend display
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
    // Validate time format (HH:mm)
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
      return res.status(400).json({ 
        success: false, 
        message: "Time must be in HH:mm format" 
      });
    }
    
    const [startHour, startMin] = startTime.split(':').map(Number);
    const [endHour, endMin] = endTime.split(':').map(Number);

    // Validate time ranges
    if (startHour < 0 || startHour > 23 || startMin < 0 || startMin > 59 ||
        endHour < 0 || endHour > 23 || endMin < 0 || endMin > 59) {
      return res.status(400).json({ 
        success: false, 
        message: "Times must be valid (HH: 0-23, MM: 0-59)" 
      });
    }
    
    const pool = getPool(db);
    
    // Check for overlapping shifts (excluding the current shift if updating)
    const [existingShifts] = await pool.query(
      `SELECT id, startTime, endTime FROM rota 
       WHERE name = ? AND lastName = ? AND day = ?`,
      [name, lastName, day]
    );
    
    // Convert new shift times to minutes for comparison
    const newStartMin = startHour * 60 + startMin;
    const newEndMin = endHour * 60 + endMin;
    
    // Check for overlaps with other shifts
    for (const existing of existingShifts) {
      // Skip the shift we're updating (if entryId is provided)
      if (entryId && existing.id == entryId) continue;
      
      const existingStart = existing.startTime.substring(0, 5);
      const existingEnd = existing.endTime.substring(0, 5);
      
      // Calculate total minutes for existing shift
      const [existingStartHour, existingStartMinute] = existingStart.split(':').map(Number);
      const [existingEndHour, existingEndMinute] = existingEnd.split(':').map(Number);
      
      const existingStartTotal = existingStartHour * 60 + existingStartMinute;
      const existingEndTotal = existingEndHour * 60 + existingEndMinute;
      
      // Check for overlap (considering overnight shifts)
      let overlap = false;
      
      // Normal case: both shifts within same day
      if (newStartMin < newEndMin && existingStartTotal < existingEndTotal) {
        overlap = (newStartMin < existingEndTotal && newEndMin > existingStartTotal);
      }
      // New shift is overnight
      else if (newStartMin > newEndMin) {
        const newEndMinNextDay = newEndMin + 1440; // Add 24 hours
        if (existingStartTotal < existingEndTotal) {
          // Existing is normal
          overlap = (newStartMin < existingEndTotal || newEndMinNextDay > existingStartTotal);
        } else {
          // Existing is also overnight
          const existingEndTotalNextDay = existingEndTotal + 1440;
          overlap = (newStartMin < existingEndTotalNextDay && newEndMinNextDay > existingStartTotal);
        }
      }
      // Existing shift is overnight
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
    
    // Add seconds to times for database storage
    const startTimeWithSeconds = ensureTimeWithSeconds(startTime);
    const endTimeWithSeconds = ensureTimeWithSeconds(endTime);
    
    if (entryId) {
      // Update existing shift
      await pool.query(
        `UPDATE rota 
         SET startTime = ?, endTime = ?, wage = ?, designation = ?
         WHERE id = ?`,
        [startTimeWithSeconds, endTimeWithSeconds, wage || 0, designation || '', entryId]
      );
      
      return res.json({ 
        success: true, 
        message: "Shift updated successfully",
        entryId: entryId
      });
    } else {
      // Check how many shifts already exist for this employee today (max 2)
      if (existingShifts.length >= 2) {
        return res.status(400).json({ 
          success: false, 
          message: "Maximum 2 shifts per day already exist" 
        });
      }
      
      // Insert new shift with unique ID
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
      
      await pool.query(
        `INSERT INTO rota (id, name, lastName, day, startTime, endTime, wage, designation) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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

// Delete a specific shift - handle both POST and DELETE methods
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

// Also keep the DELETE method for REST compatibility
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

// Add another shift (for breaks)
app.post("/add-another-shift", async (req, res) => {
  const { db, name, lastName, day, startTime, endTime, wage, designation } = req.body;
  
  if (!db || !name || !lastName || !day || !startTime || !endTime) {
    return res.status(400).json({ 
      success: false, 
      message: "All fields are required" 
    });
  }

  try {
    // Validate time format
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
      return res.status(400).json({ 
        success: false, 
        message: "Time must be in HH:mm format" 
      });
    }
    
    // Validate endTime > startTime
// Validate time format only, don't validate chronological order
// This allows overnight shifts like 22:55 - 00:55
const [startHour, startMin] = startTime.split(':').map(Number);
const [endHour, endMin] = endTime.split(':').map(Number);

// Only validate that times are within valid ranges
if (startHour < 0 || startHour > 23 || startMin < 0 || startMin > 59 ||
    endHour < 0 || endHour > 23 || endMin < 0 || endMin > 59) {
  return res.status(400).json({ 
    success: false, 
    message: "Times must be valid (HH: 0-23, MM: 0-59)" 
  });
}

// Allow any combination - overnight shifts are valid
// The frontend will calculate duration correctly
    
    const pool = getPool(db);
    
    // Check how many shifts already exist for this employee today (max 2)
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
    
    // Get existing shifts to check chronological order and overlaps
    const [existingShifts] = await pool.query(
      `SELECT startTime, endTime FROM rota 
       WHERE name = ? AND lastName = ? AND day = ?
       ORDER BY startTime ASC`,
      [name, lastName, day]
    );
    
    // Check overlaps with existing shifts (comparing without seconds)
    for (const existing of existingShifts) {
      const existingStart = existing.startTime.substring(0, 5); // HH:mm
      const existingEnd = existing.endTime.substring(0, 5); // HH:mm
      
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
    
    // Check chronological order if there's an existing shift
    if (existingShifts.length === 1) {
      const existing = existingShifts[0];
      const existingEnd = existing.endTime.substring(0, 5); // HH:mm
    }
    
    // Generate unique code
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
    
    // Add seconds to times for database storage
    const startTimeWithSeconds = ensureTimeWithSeconds(startTime);
    const endTimeWithSeconds = ensureTimeWithSeconds(endTime);
    
    // Insert new shift
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

// Get holidays for an employee
app.get("/holidays", async (req, res) => {
  const { db, email, page = 1, limit = 5 } = req.query;
  
  if (!db || !email) {
    return res.status(400).json({ 
      success: false, 
      message: "Database and email are required" 
    });
  }

  try {
    const pool = getPool(db);
    
    // 1. Get employee info from email
    const [employeeRows] = await pool.query(
      "SELECT name, lastName FROM Employees WHERE email = ?",
      [email]
    );
    
    if (!employeeRows || employeeRows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: "Employee not found" 
      });
    }
    
    const employee = employeeRows[0];
    const { name, lastName } = employee;
    
    // 2. Calculate pagination
    const pageNumber = parseInt(page);
    const limitNumber = parseInt(limit);
    const offset = (pageNumber - 1) * limitNumber;
    
    // 3. Get total count for pagination
    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total 
       FROM Holiday 
       WHERE name = ? AND lastName = ? AND accepted = 'true'`,
      [name, lastName]
    );
    
    const totalCount = countRows[0].total;
    const totalPages = Math.ceil(totalCount / limitNumber);
    
    // 4. Get paginated holidays data
    const query = `
      SELECT 
        name,
        lastName,
        startDate,
        endDate,
        requestDate,
        days,
        accepted,
        who
      FROM Holiday 
      WHERE name = ? AND lastName = ? AND accepted = 'true'
      ORDER BY requestDate DESC
      LIMIT ? OFFSET ?
    `;
    
    const [holidayRows] = await pool.query(query, [name, lastName, limitNumber, offset]);
    
    // 5. Format dates for display
    const formattedHolidays = holidayRows.map(holiday => ({
      name: holiday.name || '',
      lastName: holiday.lastName || '',
      startDate: holiday.startDate ? formatDate(holiday.startDate) : '',
      endDate: holiday.endDate ? formatDate(holiday.endDate) : '',
      requestDate: holiday.requestDate ? formatDate(holiday.requestDate) : '',
      days: holiday.days || 0,
      accepted: holiday.accepted || '',
      who: holiday.who || '',
      notes: holiday.notes || ''
    }));
    
    return res.json({
      success: true,
      holidays: formattedHolidays,
      pagination: {
        currentPage: pageNumber,
        totalPages: totalPages,
        totalItems: totalCount,
        itemsPerPage: limitNumber,
        hasNextPage: pageNumber < totalPages,
        hasPreviousPage: pageNumber > 1
      }
    });
    
  } catch (err) {
    console.error("Error fetching holidays:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Server error fetching holidays",
      error: err.message 
    });
  }
});

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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));