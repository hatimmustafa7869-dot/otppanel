// Durable storage for bot state.
//
// The problem this solves: on Hostinger every deploy replaces the application
// directory, so anything under ./data — approvals, balances, bans, pending
// order watchers — was wiped by each push. State has to live somewhere a
// deploy does not touch.
//
// Two backends, chosen by configuration:
//   * MySQL, when MYSQL_HOST/USER/DATABASE are set. Survives deploys, restarts
//     and account moves. This is the one to use in production.
//   * JSON files under DATA_DIR (default ./data). Fine locally; on a host it
//     only survives deploys if DATA_DIR points outside the deployed directory.
//
// The dataset is a handful of users, so each key is stored as one JSON blob
// rather than a schema. That keeps callers synchronous: state is read once at
// boot into memory, and writes are flushed asynchronously behind them.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE,
};

const useMysql = Boolean(MYSQL_CONFIG.host && MYSQL_CONFIG.user && MYSQL_CONFIG.database);

let pool = null;
let ready = false;
const pendingWrites = new Map(); // key -> timer, so bursts collapse into one write
const WRITE_DEBOUNCE_MS = 250;

function filePath(key) {
  return path.join(DATA_DIR, key + '.json');
}

function readFileKey(key) {
  try {
    return JSON.parse(fs.readFileSync(filePath(key), 'utf8'));
  } catch {
    return null;
  }
}

function writeFileKey(key, value) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Write to a temp file and rename, so a crash mid-write cannot truncate
    // the only copy of the state.
    const tmp = filePath(key) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, filePath(key));
  } catch (err) {
    console.error('store: file write failed for ' + key + ':', err.message);
  }
}

async function init() {
  if (!useMysql) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch { /* created lazily on first write */ }
    ready = true;
    return 'file:' + DATA_DIR;
  }

  const mysql = require('mysql2/promise');
  pool = mysql.createPool({
    ...MYSQL_CONFIG,
    waitForConnections: true,
    connectionLimit: 4,
    // Shared hosting drops idle connections; keep the pool small and let it
    // reconnect rather than holding sockets open.
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
  });

  await pool.query(
    'CREATE TABLE IF NOT EXISTS panel_state (' +
      '`k` VARCHAR(64) NOT NULL PRIMARY KEY,' +
      '`v` LONGTEXT NOT NULL,' +
      '`updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
  );

  ready = true;
  return 'mysql:' + MYSQL_CONFIG.database + '@' + MYSQL_CONFIG.host;
}

async function read(key) {
  if (!useMysql) return readFileKey(key);
  try {
    const [rows] = await pool.query('SELECT v FROM panel_state WHERE k = ?', [key]);
    if (!rows.length) return null;
    return JSON.parse(rows[0].v);
  } catch (err) {
    console.error('store: read failed for ' + key + ':', err.message);
    return null;
  }
}

async function writeNow(key, value) {
  if (!useMysql) return writeFileKey(key, value);
  try {
    await pool.query(
      'INSERT INTO panel_state (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
      [key, JSON.stringify(value)]
    );
  } catch (err) {
    // Never throw into a Telegram handler over a failed persist: log it, and
    // keep serving from memory.
    console.error('store: write failed for ' + key + ':', err.message);
  }
}

// Fire-and-forget, debounced. Callers stay synchronous.
function write(key, value) {
  const existing = pendingWrites.get(key);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingWrites.delete(key);
    writeNow(key, value).catch(() => {});
  }, WRITE_DEBOUNCE_MS);
  if (timer.unref) timer.unref();
  pendingWrites.set(key, { timer, value });
}

// Flushes anything still debounced — used before shutdown.
async function flush() {
  const entries = [...pendingWrites.entries()];
  pendingWrites.clear();
  for (const [key, { timer, value }] of entries) {
    clearTimeout(timer);
    await writeNow(key, value);
  }
}

// One-time import of on-disk state into MySQL, so switching backends does not
// start from nothing. Only runs when the database has no row for that key yet.
async function migrateFromFiles(keys) {
  if (!useMysql) return [];
  const migrated = [];
  for (const key of keys) {
    const existing = await read(key);
    if (existing !== null) continue;
    const fromFile = readFileKey(key);
    if (fromFile === null) continue;
    await writeNow(key, fromFile);
    migrated.push(key);
  }
  return migrated;
}

module.exports = { init, read, write, writeNow, flush, migrateFromFiles, useMysql, isReady: () => ready };
