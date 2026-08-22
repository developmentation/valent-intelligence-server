'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Render Postgres requires SSL from outside its network; inside it's plain. Accept self-signed.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : (process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false),
  max: 8,
});

/**
 * Apply every migrations/*.sql not yet recorded, in filename order, each in its own transaction,
 * exactly once. The schema lives in migrations/ (sequenced files) — NOT inline here — so every DB
 * change is tracked and replayable. See migrations/README.md.
 */
async function migrate() {
  await pool.query(
    `create table if not exists schema_migrations (
       version text primary key,
       applied_at timestamptz default now()
     )`);
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(
    (await pool.query('select version from schema_migrations')).rows.map((r) => r.version));

  for (const f of files) {
    const version = f.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (version) values ($1)', [version]);
      await client.query('commit');
      console.log(`migrated: ${version}`);
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw new Error(`migration ${version} failed: ${e.message}`);
    } finally {
      client.release();
    }
  }
}

async function init() {
  await migrate();
}

module.exports = { pool, init, migrate };
