// ========== NEW ENDPOINTS FOR SHIFT TIME MANAGEMENT ==========

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
    
    // 2. Get today's date in dd/mm/yyyy format
    const today = new Date();
    const day = `${String(today.getDate()).padStart(2, '0')}/${
      String(today.getMonth() + 1).padStart(2, '0')}/${
      today.getFullYear()}`;
    
    // 3. Get today's shifts (max 2)
    const [shiftRows] = await pool.query(
      `SELECT id, name, lastName, day, startTime, endTime 
       FROM rota 
       WHERE name = ? AND lastName = ? AND day = ?
       ORDER BY startTime ASC`,
      [name, lastName, day]
    );
    
    return res.json({
      success: true,
      employee: { name, lastName },
      today: day,
      shifts: shiftRows
    });
    
  } catch (err) {
    console.error("Error fetching today's shifts:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Server error fetching shifts" 
    });
  }
});

// Update an existing shift
app.put("/update-shift", async (req, res) => {
  const { db, id, startTime, endTime } = req.body;
  
  if (!db || !id || !startTime || !endTime) {
    return res.status(400).json({ 
      success: false, 
      message: "Database, shift ID, startTime, and endTime are required" 
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
    
    // Validate endTime > startTime
    const [startHour, startMin] = startTime.split(':').map(Number);
    const [endHour, endMin] = endTime.split(':').map(Number);
    const startTotal = startHour * 60 + startMin;
    const endTotal = endHour * 60 + endMin;
    
    if (endTotal <= startTotal) {
      return res.status(400).json({ 
        success: false, 
        message: "End time must be after start time" 
      });
    }
    
    const pool = getPool(db);
    
    // Get the shift to check for overlaps
    const [shiftRows] = await pool.query(
      `SELECT name, lastName, day FROM rota WHERE id = ?`,
      [id]
    );
    
    if (!shiftRows || shiftRows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: "Shift not found" 
      });
    }
    
    const shift = shiftRows[0];
    
    // Check for overlaps with other shifts on same day
    const [overlapRows] = await pool.query(
      `SELECT id FROM rota 
       WHERE name = ? AND lastName = ? AND day = ? AND id != ?
         AND (
           (? < endTime AND ? > startTime) OR
           (? < endTime AND ? > startTime) OR
           (? <= startTime AND ? >= endTime)
         )`,
      [
        shift.name, shift.lastName, shift.day, id,
        startTime, startTime,
        endTime, endTime,
        startTime, endTime
      ]
    );
    
    if (overlapRows.length > 0) {
      return res.status(400).json({ 
        success: false, 
        message: "Shift overlaps with existing shift" 
      });
    }
    
    // Update the shift
    await pool.query(
      `UPDATE rota SET startTime = ?, endTime = ? WHERE id = ?`,
      [startTime, endTime, id]
    );
    
    return res.json({ 
      success: true, 
      message: "Shift updated successfully" 
    });
    
  } catch (err) {
    console.error("Error updating shift:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Server error updating shift" 
    });
  }
});

// Add a new shift for today (for breaks)
app.post("/add-shift", async (req, res) => {
  const { db, name, lastName, day, startTime, endTime } = req.body;
  
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
    const [startHour, startMin] = startTime.split(':').map(Number);
    const [endHour, endMin] = endTime.split(':').map(Number);
    const startTotal = startHour * 60 + startMin;
    const endTotal = endHour * 60 + endMin;
    
    if (endTotal <= startTotal) {
      return res.status(400).json({ 
        success: false, 
        message: "End time must be after start time" 
      });
    }
    
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
    
    // Check overlaps with existing shifts
    for (const existing of existingShifts) {
      if (
        (startTime < existing.endTime && endTime > existing.startTime) ||
        (endTime > existing.startTime && startTime < existing.endTime)
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
      // Ensure shifts are in chronological order
      if (startTime < existing.endTime) {
        return res.status(400).json({ 
          success: false, 
          message: "New shift must start after existing shift ends" 
        });
      }
    }
    
    // Insert new shift
    const [result] = await pool.query(
      `INSERT INTO rota (name, lastName, day, startTime, endTime) 
       VALUES (?, ?, ?, ?, ?)`,
      [name, lastName, day, startTime, endTime]
    );
    
    return res.json({ 
      success: true, 
      message: "Shift added successfully",
      id: result.insertId 
    });
    
  } catch (err) {
    console.error("Error adding shift:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Server error adding shift" 
    });
  }
});

// Delete a shift (optional, for cleanup)
app.delete("/delete-shift", async (req, res) => {
  const { db, id } = req.body;
  
  if (!db || !id) {
    return res.status(400).json({ 
      success: false, 
      message: "Database and shift ID are required" 
    });
  }

  try {
    const pool = getPool(db);
    
    await pool.query(
      `DELETE FROM rota WHERE id = ?`,
      [id]
    );
    
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