import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL wajib diisi. Lihat .env.example.');

export const pool = mysql.createPool(databaseUrl);

export async function connectWithRetry(attempts = 30) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * attempt, 5000)));
    }
  }
  throw lastError;
}

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const migrationsDirectory = path.resolve('migrations');
  const files = (await fs.readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const [rows] = await pool.execute('SELECT name FROM schema_migrations WHERE name = ?', [file]);
    if (rows.length) continue;

    const sql = await fs.readFile(path.join(migrationsDirectory, file), 'utf8');
    const statements = sql.split(/^-- migrate:split\s*$/m).map((value) => value.trim()).filter(Boolean);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const statement of statements) await connection.query(statement);
      await connection.execute('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

export async function transaction(callback) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
