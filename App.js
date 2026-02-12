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

// ==================== FEED ENDPOINTS ====================

// Create a new feed post
// Create a new feed post - FULLY FIXED
app.post("/feed/create", async (req, res) => {
  const { db, authorEmail, content, attachments, visibility = 'all', mentions = [], poll } = req.body;

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
      } catch (pollError) {
        console.error("Error creating poll:", pollError);
      }
    }

    // ===========================================
    // 3. INSERT MEDIA IF EXISTS
    // ===========================================
    if (attachments && attachments.length > 0) {
      for (const attachment of attachments) {
        try {
          const mediaId = generatePostId();
          await pool.query(
            `INSERT INTO FeedMedia (id, postId, type, url, filename, filesize, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              mediaId,
              postId,
              attachment.type || 'file',
              attachment.url || null,
              attachment.name || null,
              attachment.size || 0,
              new Date()
            ]
          );
        } catch (mediaError) {
          console.error("Error inserting media:", mediaError);
        }
      }
    }

    // Set per tracciare utenti già notificati (evita duplicati)
    const notifiedUsers = new Set();
    const mentionDetails = [];
    
    // ===========================================
    // 4. PROCESS MENTIONS
    // ===========================================
    if (mentions && mentions.length > 0) {
      for (const mention of mentions) {
        // Pulisci il testo della menzione (rimuovi @ se presente)
        const cleanMention = mention.replace('@', '').trim();
        
        if (cleanMention.length < 2) continue;

        // Cerca l'impiegato in diversi modi
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
          // Non notificare l'autore del post
          if (mentionedUser.email !== authorEmail && !notifiedUsers.has(mentionedUser.email)) {
            notifiedUsers.add(mentionedUser.email);
            
            // 📌 4a. SEND MENTION NOTIFICATION
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
              console.log(`Mention notification sent to: ${mentionedUser.email}`);
            } catch (notifError) {
              console.error("Error inserting mention notification:", notifError);
            }

            // 📌 4b. STORE MENTION IN FeedPostMentions TABLE
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
              
              console.log(`Mention stored for: ${mentionedUser.email}`);
            } catch (mentionError) {
              console.error("Error storing mention:", mentionError);
            }
          }
        }
      }
    }

    // ===========================================
    // 5. SEND NOTIFICATIONS TO ALL USERS
    // ===========================================
    try {
      // Get all employees except the author
      const [allEmployees] = await pool.query(
        `SELECT email FROM Employees WHERE email != ?`,
        [authorEmail]
      );
      
      const title = "📱 New Feed Post";
      const message = `${authorName} posted: "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`;
      
      // Insert one notification per user (efficient batch insert)
      if (allEmployees.length > 0) {
        const values = allEmployees.map(emp => [
          'USER',           // targetRole
          emp.email,        // targetEmail
          authorEmail,      // authorEmail
          title,           // title
          message,         // message
          'FEED',          // type
          postId,          // postId
          false,           // isRead
          new Date()       // createdAt
        ]);
        
        // Use batch insert for better performance
        const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
        const flatValues = values.flat();
        
        await pool.query(
          `INSERT INTO Notifications 
           (targetRole, targetEmail, authorEmail, title, message, type, postId, isRead, createdAt)
           VALUES ${placeholders}`,
          flatValues
        );
        
        console.log(`Feed notifications sent to ${allEmployees.length} users`);
      }
    } catch (notifError) {
      console.error("Error sending notifications to all users:", notifError);
    }

    // ===========================================
    // 6. RETURN SUCCESS RESPONSE
    // ===========================================
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
        attachments: attachments || [],
        visibility: visibilityStr,
        createdAt,
        isPinned: false,
        isActive: true,
        likes: 0,
        comments: 0,
        likedByUser: false,
        mentions: mentionDetails,
        hasPoll: !!poll
      }
    });

  } catch (err) {
    console.error("Error creating feed post:", err);
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

    // ✅ FIXED: Use correct table names FeedPosts, FeedLikes, FeedComments
    let query = `
      SELECT 
        p.*,
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

    if (filter === 'pinned') {
      query += ` AND p.isPinned = true`;
    } else if (filter === 'my_posts') {
      query += ` AND p.authorEmail = ?`;
      params.push(userEmail);
    }

    query += ` ORDER BY p.isPinned DESC, p.createdAt DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), offset);

    const [posts] = await pool.query(query, params);

    // Get mentions for each post
    for (let i = 0; i < posts.length; i++) {
      const [mentions] = await pool.query(
        `SELECT mentionedEmail, mentionedName FROM FeedPostMentions WHERE postId = ?`,
        [posts[i].id]
      );
      posts[i].mentions = mentions.map(m => m.mentionedName);
    }

    // Parse attachments JSON
    const formattedPosts = posts.map(post => ({
      ...post,
      attachments: post.attachments ? JSON.parse(post.attachments) : [],
      createdAt: post.createdAt,
      expiresAt: post.expiresAt,
      likes: parseInt(post.likes_count) || 0,
      comments: parseInt(post.comments_count) || 0,
      likedByUser: !!post.liked_by_user
    }));

    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total FROM FeedPosts WHERE isActive = true`
    );

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
    console.error("Error fetching feed posts:", err);
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

// Add comment to post
app.post("/feed/comment", async (req, res) => {
  const { db, postId, userEmail, content } = req.body;

  if (!db || !postId || !userEmail || !content) {
    return res.status(400).json({
      success: false,
      message: "Database, postId, userEmail, and content are required"
    });
  }

  try {
    const pool = getPool(db);
    const commentId = generateUniqueCode();

    // Get user info
    const [userRows] = await pool.query(
      "SELECT name, lastName, designation FROM Employees WHERE email = ?",
      [userEmail]
    );

    if (!userRows || userRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const user = userRows[0];
    const userName = `${user.name} ${user.lastName}`;

    // Insert comment
    await pool.query(
      `INSERT INTO FeedComments (id, postId, userEmail, userName, userDesignation, content, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [commentId, postId, userEmail, userName, user.designation || '', content]
    );

    // Get post author for notification
    const [postRows] = await pool.query(
      "SELECT authorName, authorEmail FROM FeedPosts WHERE id = ?",
      [postId]
    );

    if (postRows.length > 0 && postRows[0].authorEmail !== userEmail) {
      const post = postRows[0];
      
      // Create notification for post author
      await pool.query(
        `INSERT INTO Notifications (targetRole, title, message, type, postId)
         VALUES (?, ?, ?, ?, ?)`,
        ['ALL', 'New Comment', `${userName} commented on your post: ${content.substring(0, 50)}${content.length > 50 ? '...' : ''}`, 'FEED', postId]
      );
    }

    // Get updated comment count
    const [countResult] = await pool.query(
      "SELECT COUNT(*) as count FROM FeedComments WHERE postId = ?",
      [postId]
    );

    return res.json({
      success: true,
      message: "Comment added successfully",
      comment: {
        id: commentId,
        postId,
        userEmail,
        userName,
        userDesignation: user.designation,
        content,
        createdAt: new Date()
      },
      comments: countResult[0].count
    });

  } catch (err) {
    console.error("Error adding comment:", err);
    return res.status(500).json({
      success: false,
      message: "Server error adding comment",
      error: err.message
    });
  }
});

// Get comments for a post
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

    const [comments] = await pool.query(
      `SELECT * FROM FeedComments 
       WHERE postId = ? 
       ORDER BY createdAt DESC`,
      [postId]
    );

    return res.json({
      success: true,
      comments
    });

  } catch (err) {
    console.error("Error fetching comments:", err);
    return res.status(500).json({
      success: false,
      message: "Server error fetching comments",
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
    console.error("Error deleting comment:", err);
    return res.status(500).json({
      success: false,
      message: "Server error deleting comment",
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
      message: "Database, postId, and userEmail are required"
    });
  }

  try {
    const pool = getPool(db);

    // Check if user has permission (Manager or AM)
    const [userRows] = await pool.query(
      `SELECT Access FROM users WHERE Email = ? AND db_name = ?`,
      [userEmail, db]
    );

    const isManager = userRows.some(row => 
      row.Access && ['manager', 'am'].includes(row.Access.toLowerCase())
    );

    if (!isManager) {
      return res.status(403).json({
        success: false,
        message: "Only managers and AMs can pin/unpin posts"
      });
    }

    await pool.query(
      "UPDATE FeedPosts SET isPinned = ? WHERE id = ?",
      [pin === true || pin === 'true', postId]
    );

    return res.json({
      success: true,
      message: pin ? "Post pinned successfully" : "Post unpinned successfully",
      isPinned: pin === true || pin === 'true'
    });

  } catch (err) {
    console.error("Error pinning/unpinning post:", err);
    return res.status(500).json({
      success: false,
      message: "Server error updating post",
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
      message: "Database, postId, and userEmail are required"
    });
  }

  try {
    const pool = getPool(db);

    // Get post info
    const [postRows] = await pool.query(
      "SELECT * FROM FeedPosts WHERE id = ?",
      [postId]
    );

    if (postRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Post not found"
      });
    }

    const post = postRows[0];

    // Check if user has permission (author, Manager, or AM)
    const [userRows] = await pool.query(
      `SELECT Access FROM users WHERE Email = ? AND db_name = ?`,
      [userEmail, db]
    );

    const isManager = userRows.some(row => 
      row.Access && ['manager', 'am'].includes(row.Access.toLowerCase())
    );
    const isAuthor = post.authorEmail === userEmail;

    if (!isAuthor && !isManager) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to delete this post"
      });
    }

    // Soft delete - mark as inactive
    await pool.query(
      "UPDATE FeedPosts SET isActive = false WHERE id = ?",
      [postId]
    );

    return res.json({
      success: true,
      message: "Post deleted successfully"
    });

  } catch (err) {
    console.error("Error deleting post:", err);
    return res.status(500).json({
      success: false,
      message: "Server error deleting post",
      error: err.message
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

    const [employeeRows] = await pool.query(
      "SELECT name, lastName FROM Employees WHERE email = ?",
      [email]
    );

    if (!employeeRows.length) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    const { name, lastName } = employeeRows[0];

    const [settingsRows] = await pool.query(`
      SELECT HolidayYearStart, HolidayYearEnd
      FROM HolidayYearSettings
      WHERE CURDATE() BETWEEN HolidayYearStart AND HolidayYearEnd
      LIMIT 1
    `);

    const yearStart = settingsRows[0].HolidayYearStart;
    const yearEnd = settingsRows[0].HolidayYearEnd;

    const startDateSql = `STR_TO_DATE(SUBSTRING_INDEX(startDate, ' ', 1), '%d/%m/%Y')`;
    const requestDateSql = `STR_TO_DATE(SUBSTRING_INDEX(requestDate, ' ', 1), '%d/%m/%Y')`;

    const [pendingRows] = await pool.query(`
      SELECT * FROM Holiday
      WHERE name = ? AND lastName = ?
      AND (
          accepted IS NULL
          OR TRIM(accepted) = ''
          OR LOWER(TRIM(accepted)) = 'unpaid'
      )
      AND (who IS NULL OR TRIM(who) = '')
      ORDER BY ${requestDateSql} DESC
    `, [name, lastName]);

    const [currentRows] = await pool.query(`
      SELECT * FROM Holiday
      WHERE name = ? AND lastName = ?
      AND who IS NOT NULL AND TRIM(who) <> ''
      AND ${startDateSql} BETWEEN ? AND ?
      ORDER BY ${startDateSql} ASC
    `, [name, lastName, yearStart, yearEnd]);

    const [pastRows] = await pool.query(`
      SELECT *, YEAR(${startDateSql}) AS holidayYear
      FROM Holiday
      WHERE name = ? AND lastName = ?
      AND who IS NOT NULL AND TRIM(who) <> ''
      AND ${startDateSql} < ?
      ORDER BY ${startDateSql} DESC
    `, [name, lastName, yearStart]);

    const formatRow = (row) => {
      const accepted = (row.accepted || '').toLowerCase();
      const isUnpaid = accepted === 'unpaid';
      const isApproved = row.who && row.who.trim() !== '';

      return {
        startDate: row.startDate,
        endDate: row.endDate,
        requestDate: row.requestDate,
        days: row.days || 0,
        who: row.who || '',
        notes: row.notes || '',
        status: !isApproved ? "Pending"
              : accepted === 'false' ? "Declined"
              : isUnpaid ? "Approved Unpaid"
              : "Approved Paid"
      };
    };

    const pastByYear = {};
    for (const row of pastRows) {
      const y = String(row.holidayYear || "Unknown");
      if (!pastByYear[y]) pastByYear[y] = [];
      pastByYear[y].push(formatRow(row));
    }

    res.json({
      success: true,
      holidayYear: { start: yearStart, end: yearEnd },
      pendingHolidays: pendingRows.map(formatRow),
      currentHolidays: currentRows.map(formatRow),
      pastByYear
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