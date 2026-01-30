// backend/dbManager.js
import mysql from "mysql2/promise";
import { databasesConfig } from "./db.js";

const poolMap = {};

export function getPool(dbName) {
  if (!databasesConfig[dbName]) {
    throw new Error(`No configuration for database ${dbName}`);
  }

  if (poolMap[dbName]) return poolMap[dbName];

  const config = databasesConfig[dbName];
  const pool = mysql.createPool({
    host: config.host,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  poolMap[dbName] = pool;
  return pool;
}
