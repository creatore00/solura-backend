import mysql from "mysql2/promise";

// Database connection details
// WARNING: Hardcoding is fine for testing, but NOT recommended for production
export const pool = mysql.createPool({
  host: "sv41.byethost41.org",       // Your DB host
  user: "yassir_yassir",             // Your DB username
  password: "Qazokm123890",          // Your DB password
  database: "yassir_access",         // Your DB name
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});
