import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

/**
 * Two ways to connect, on purpose:
 *   DATABASE_URL  — a single connection string (Neon, Render, Railway, Supabase)
 *   DB_HOST/...   — discrete vars, for a local Postgres or Docker container
 *
 * Hosted Postgres requires TLS; a local one usually has no certificate at all,
 * so SSL follows the connection string rather than being hardcoded either way.
 */
const connectionString = process.env.DATABASE_URL;

export const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
    })
  : new Pool({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      database: process.env.DB_NAME ?? 'support_ops_agent',
    });

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err);
});

export default pool;
