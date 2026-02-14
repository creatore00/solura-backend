import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import { pool } from "./config/db.js"; // only for login users table
import { getPool } from "./config/dbManager.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increased limit for image uploads
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
  const { db, email } = req.query;

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

    // 2) Get ALL holiday years
    const [yearRows] = await pool.query(`
      SELECT HolidayYearStart AS start, HolidayYearEnd AS end
      FROM HolidayYearSettings
      ORDER BY HolidayYearStart DESC
    `);

    // Helper: date parse expression from your stored strings dd/mm/yyyy (...)
    const startDateSql = `STR_TO_DATE(SUBSTRING_INDEX(startDate, ' ', 1), '%d/%m/%Y')`;
    const requestDateSql = `STR_TO_DATE(SUBSTRING_INDEX(requestDate, ' ', 1), '%d/%m/%Y')`;

    // Helper: determine the holiday-year window for a given JS Date
    const findYearWindowForDate = (dateObj) => {
      for (const y of yearRows) {
        const ys = new Date(y.start);
        const ye = new Date(y.end);
        // Normalize time
        ys.setHours(0, 0, 0, 0);
        ye.setHours(23, 59, 59, 999);
        if (dateObj >= ys && dateObj <= ye) {
          return { start: y.start, end: y.end };
        }
      }
      return null;
    };

    // Helper: compute accrual for a given year window
    const calcAccrued = (yearStart, yearEnd) => {
      if (!allowanceDays) return 0;

      const today = new Date();
      const ys = new Date(yearStart);
      const ye = new Date(yearEnd);

      ys.setHours(0, 0, 0, 0);
      ye.setHours(23, 59, 59, 999);

      if (today < ys) return 0;
      if (today > ye) return allowanceDays;

      const msPerDay = 24 * 60 * 60 * 1000;
      const totalDays = Math.floor((ye - ys) / msPerDay) + 1;
      const elapsedDays = Math.floor((today - ys) / msPerDay) + 1;

      const accrued = (allowanceDays * elapsedDays) / totalDays;
      return Math.min(allowanceDays, accrued);
    };

    // 3) Pull ALL employee holidays (approved + pending + declined)
    const [allRows] = await pool.query(
      `
      SELECT *
      FROM Holiday
      WHERE name = ? AND lastName = ?
      ORDER BY ${requestDateSql} DESC
      `,
      [name, lastName]
    );

    // 4) Normalize a row into a UI-friendly shape
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
        type,               // "Paid" / "Unpaid"
        accepted: acceptedRaw,
      };
    };

    // 5) Group into holiday years based on the custom year boundaries
    // We'll use a key: "YYYY-MM-DD → YYYY-MM-DD"
    const yearsMap = new Map();

    const ensureYearBucket = (yearStart, yearEnd) => {
      const key = `${yearStart} → ${yearEnd}`;
      if (!yearsMap.has(key)) {
        yearsMap.set(key, {
          key,
          start: yearStart,
          end: yearEnd,

          allowanceDays,
          accruedDays: Number(calcAccrued(yearStart, yearEnd).toFixed(2)),

          takenPaidDays: 0,
          takenUnpaidDays: 0,
          pendingPaidDays: 0,
          pendingUnpaidDays: 0,
          declinedDays: 0,

          pendingHolidays: [],
          approvedHolidays: [],
          declinedHolidays: [],
        });
      }
      return yearsMap.get(key);
    };

    // We need start date as real date to map into year
    // Convert MySQL STR_TO_DATE in SQL? We already pulled strings, so parse dd/mm/yyyy:
    const parseDDMMYYYY = (s) => {
      const d = (s ?? "").toString().trim().split(" ")[0];
      const parts = d.split("/");
      if (parts.length !== 3) return null;
      const dd = parseInt(parts[0], 10);
      const mm = parseInt(parts[1], 10);
      const yyyy = parseInt(parts[2], 10);
      if (!dd || !mm || !yyyy) return null;
      const dt = new Date(yyyy, mm - 1, dd);
      dt.setHours(0, 0, 0, 0);
      return dt;
    };

    for (const row of allRows) {
      const startDt = parseDDMMYYYY(row.startDate);
      if (!startDt) continue;

      const win = findYearWindowForDate(startDt);
      if (!win) continue;

      const bucket = ensureYearBucket(win.start, win.end);
      const item = normalizeRow(row);

      const days = item.days || 0;
      const status = item.status.toLowerCase();
      const type = item.type.toLowerCase(); // paid/unpaid

      if (status.startsWith("approved")) {
        bucket.approvedHolidays.push(item);
        if (type === "paid") bucket.takenPaidDays += days;
        else bucket.takenUnpaidDays += days;
      } else if (status === "declined") {
        bucket.declinedHolidays.push(item);
        bucket.declinedDays += days;
      } else {
        bucket.pendingHolidays.push(item);
        if (type === "paid") bucket.pendingPaidDays += days;
        else bucket.pendingUnpaidDays += days;
      }
    }

    // 6) Finalize per-year remaining values
    const years = Array.from(yearsMap.values())
      .map((y) => {
        const remainingYearDays = Math.max(0, y.allowanceDays - y.takenPaidDays);
        const availableNowDays = Math.max(0, Math.min(y.accruedDays, y.allowanceDays) - y.takenPaidDays);

        return {
          ...y,
          remainingYearDays: Number(remainingYearDays.toFixed(2)),
          availableNowDays: Number(availableNowDays.toFixed(2)),
        };
      })
      // sort latest year first
      .sort((a, b) => new Date(b.start) - new Date(a.start));

    // Current year (the one where today fits)
    const today = new Date();
    let currentYearKey = null;
    for (const y of years) {
      const ys = new Date(y.start); ys.setHours(0, 0, 0, 0);
      const ye = new Date(y.end); ye.setHours(23, 59, 59, 999);
      if (today >= ys && today <= ye) {
        currentYearKey = y.key;
        break;
      }
    }

    res.json({
      success: true,
      employee: { name, lastName, allowanceDays },
      currentYearKey,
      years,
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

    // Filtra per ruolo O email specifica
    if (role) {
      query += ` AND (targetRole = ? OR targetRole = 'ALL')`;
      params.push(role);
    }
    
    if (userEmail) {
      query += ` OR targetEmail = ?`;
      params.push(userEmail);
    }

    query += ` ORDER BY id DESC LIMIT 50`;

    const [rows] = await pool.query(query, params);

    // Formatta le date per il frontend
    const notifications = rows.map(row => ({
      ...row,
      createdAt: row.createdAt ? row.createdAt.toISOString() : null
    }));

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

// Get unread count
app.get("/notifications/unread-count", async (req, res) => {
  const { db, role, userEmail } = req.query;

  if (!db) {
    return res.status(400).json({ success: false, message: "db is required" });
  }

  try {
    const pool = getPool(db);
    
    let query = `
      SELECT COUNT(*) as count 
      FROM Notifications 
      WHERE isRead = 0
    `;
    const params = [];

    if (role) {
      query += ` AND (targetRole = ? OR targetRole = 'ALL')`;
      params.push(role);
    }
    
    if (userEmail) {
      query += ` OR targetEmail = ?`;
      params.push(userEmail);
    }

    const [result] = await pool.query(query, params);

    res.json({ 
      success: true, 
      count: result[0].count 
    });

  } catch (err) {
    console.error("Error fetching unread count:", err);
    res.status(500).json({ 
      success: false, 
      message: "Server error fetching unread count" 
    });
  }
});

// Mark notification as read
app.post("/notifications/read", async (req, res) => {
  const { db, id } = req.body;

  if (!db || !id) {
    return res.status(400).json({
      success: false,
      message: "db and id are required"
    });
  }

  try {
    const pool = getPool(db);

    await pool.query(
      "UPDATE Notifications SET isRead = 1 WHERE id = ?",
      [id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Error marking notification read:", err);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));