// backend/config/db.js
import mysql from "mysql2/promise";

// Main access database (users table)
export const pool = mysql.createPool({
  host: "sv41.byethost41.org",
  user: "yassir_yassir",
  password: "Qazokm123890",
  database: "yassir_access",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Config for multiple databases
export const databasesConfig = {
  "100%pastaoxford": {
    host: "sv41.byethost41.org",
    user: "yassir_100pastaoxford",
    password: "Qazokm123890",
    database: "yassir_100%pastaoxford",
  },
  "bbuonaoxford": {
    host: "sv41.byethost41.org",
    user: "yassir_bbuonaoxford",
    password: "Qazokm123890",
    database: "yassir_bbuonaoxford",
  },
  // add more dynamically in the future
};
