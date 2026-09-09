// Who may use the Telegram bot.
//
// Access is request-and-approve rather than a fixed list: a stranger who finds
// the bot gets a pending request, and only the owner can turn that into access.
// This matters because every approved user spends the owner's JuicySMS balance.
const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, 'data', 'tg-users.json');

const empty = { ownerId: null, approved: {}, pending: {}, denied: {}, limits: {}, spend: {} };
let store = null;

function load() {
  if (store) return store;
  try {
    store = { ...empty, ...JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) };
    // Older stores predate spending limits.
    store.limits = store.limits || {};
    store.spend = store.spend || {};
  } catch {
    store = { ...empty, approved: {}, pending: {}, denied: {}, limits: {}, spend: {} };
  }
  return store;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error('Could not persist Telegram users:', err.message);
  }
}

// Ids from the environment are always approved and cannot be revoked from
// chat — a way to guarantee at least one working account after a data wipe.
function envIds() {
  return String(process.env.TELEGRAM_ALLOWED_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function describe(from) {
  return {
    id: String(from.id),
    username: from.username || null,
    name: [from.first_name, from.last_name].filter(Boolean).join(' ') || null,
    at: new Date().toISOString(),
  };
}

// Ownership is a list: TELEGRAM_OWNER_ID accepts comma-separated ids so more
// than one person can approve requests. Env ids win over the claimed one.
function ownerIds() {
  const s = load();
  const fromEnv = String(process.env.TELEGRAM_OWNER_ID || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (fromEnv.length) return fromEnv;
  return s.ownerId ? [String(s.ownerId)] : [];
}

// First owner — used where a single addressee is needed.
function ownerId() {
  return ownerIds()[0] || null;
}

function isOwner(id) {
  return ownerIds().includes(String(id));
}

// The bot has no owner until someone claims it. The first person to /start
// becomes the owner, which is how the account bootstraps without knowing any
// Telegram id in advance. Set TELEGRAM_OWNER_ID to pin it permanently.
function claimOwner(from) {
  const s = load();
  if (ownerId()) return false;
  s.ownerId = String(from.id);
  s.approved[String(from.id)] = { ...describe(from), role: 'owner' };
  save();
  return true;
}

function isApproved(id) {
  const s = load();
  return isOwner(id) || envIds().includes(String(id)) || Boolean(s.approved[String(id)]);
}

function isDenied(id) {
  return Boolean(load().denied[String(id)]);
}

function isPending(id) {
  return Boolean(load().pending[String(id)]);
}

function requestAccess(from) {
  const s = load();
  const id = String(from.id);
  if (isApproved(id) || isDenied(id)) return false;
  if (s.pending[id]) return false;
  s.pending[id] = describe(from);
  save();
  return true;
}

function approve(id) {
  const s = load();
  const key = String(id);
  const record = s.pending[key] || s.denied[key] || { id: key, at: new Date().toISOString() };
  delete s.pending[key];
  delete s.denied[key];
  s.approved[key] = { ...record, approved_at: new Date().toISOString() };
  save();
  return s.approved[key];
}

function deny(id) {
  const s = load();
  const key = String(id);
  const record = s.pending[key] || { id: key };
  delete s.pending[key];
  delete s.approved[key];
  s.denied[key] = { ...record, denied_at: new Date().toISOString() };
  save();
  return s.denied[key];
}

function revoke(id) {
  const s = load();
  const key = String(id);
  if (isOwner(key)) return false; // the owner cannot lock themselves out
  const existed = Boolean(s.approved[key]);
  delete s.approved[key];
  save();
  return existed;
}

function list() {
  const s = load();
  return {
    ownerId: ownerId(),
    ownerIds: ownerIds(),
    approved: Object.values(s.approved),
    pending: Object.values(s.pending),
    denied: Object.values(s.denied),
    envIds: envIds(),
  };
}

// ---------- Daily spending limits ----------
// All arithmetic is in integer cents (the API's amount_minor). Never floats:
// a cent lost to rounding here is a real charge that went unaccounted for.

const DEFAULT_LIMIT_MINOR = (() => {
  const raw = process.env.TELEGRAM_DEFAULT_DAILY_LIMIT;
  if (raw === undefined || raw === '') return 500; // €5.00/day unless told otherwise
  if (/^(none|unlimited|0+(\.0+)?)$/i.test(String(raw).trim())) {
    return /^(none|unlimited)$/i.test(String(raw).trim()) ? null : 0;
  }
  const cents = Math.round(Number(raw) * 100);
  return Number.isFinite(cents) && cents >= 0 ? cents : 500;
})();

function today() {
  return new Date().toISOString().slice(0, 10); // UTC day
}

// null means unlimited. Owners are never limited — it is their balance.
function getLimit(id) {
  if (isOwner(id)) return null;
  const s = load();
  const own = s.limits[String(id)];
  if (own === undefined) return DEFAULT_LIMIT_MINOR;
  return own === null ? null : Number(own);
}

function setLimit(id, minorOrNull) {
  const s = load();
  s.limits[String(id)] = minorOrNull === null ? null : Math.max(0, Math.round(Number(minorOrNull)));
  save();
  return s.limits[String(id)];
}

function todaySpend(id) {
  const s = load();
  const rec = s.spend[String(id)];
  if (!rec || rec.date !== today()) return 0;
  return Number(rec.minor) || 0;
}

// null means unlimited remaining.
function remaining(id) {
  const limit = getLimit(id);
  if (limit === null) return null;
  return Math.max(0, limit - todaySpend(id));
}

function addSpend(id, minor) {
  const amount = Math.max(0, Math.round(Number(minor) || 0));
  if (!amount) return todaySpend(id);
  const s = load();
  const key = String(id);
  const rec = s.spend[key];
  s.spend[key] = rec && rec.date === today()
    ? { date: rec.date, minor: (Number(rec.minor) || 0) + amount }
    : { date: today(), minor: amount };
  save();
  return s.spend[key].minor;
}

// An order that ends with no SMS is never charged, so the reservation is released.
function refundSpend(id, minor) {
  const amount = Math.max(0, Math.round(Number(minor) || 0));
  if (!amount) return todaySpend(id);
  const s = load();
  const key = String(id);
  const rec = s.spend[key];
  if (!rec || rec.date !== today()) return 0;
  rec.minor = Math.max(0, (Number(rec.minor) || 0) - amount);
  save();
  return rec.minor;
}

function eur(minor) {
  if (minor === null || minor === undefined) return 'unlimited';
  return '€' + (Number(minor) / 100).toFixed(2);
}

module.exports = {
  load, ownerId, ownerIds, isOwner, claimOwner, isApproved, isDenied, isPending,
  requestAccess, approve, deny, revoke, list, describe,
  getLimit, setLimit, todaySpend, remaining, addSpend, refundSpend, eur,
  DEFAULT_LIMIT_MINOR,
};
