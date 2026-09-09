// Who may use the Telegram bot.
//
// Access is request-and-approve rather than a fixed list: a stranger who finds
// the bot gets a pending request, and only the owner can turn that into access.
// This matters because every approved user spends the owner's JuicySMS balance.
const backend = require('./store');

const STORE_KEY = 'tg-users';

const empty = {
  ownerId: null, approved: {}, pending: {}, denied: {},
  limits: {}, spend: {}, credits: {},
};
let store = null;

function blank() {
  return { ownerId: null, approved: {}, pending: {}, denied: {}, limits: {}, spend: {}, credits: {} };
}

function normalise(raw) {
  const s = { ...empty, ...(raw || {}) };
  // Older records predate spending limits and credit.
  s.approved = s.approved || {};
  s.pending = s.pending || {};
  s.denied = s.denied || {};
  s.limits = s.limits || {};
  s.spend = s.spend || {};
  s.credits = s.credits || {};
  return s;
}

// Reads the persisted state once, at boot, into memory. Everything below stays
// synchronous so no call site has to become async.
async function init() {
  store = normalise(await backend.read(STORE_KEY));
  return store;
}

function load() {
  if (!store) store = blank();
  return store;
}

function save() {
  backend.write(STORE_KEY, store);
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
  if (isOwner(id)) return true;
  // A ban overrides everything, including the environment allowlist — otherwise
  // banning someone listed there would silently do nothing.
  if (isDenied(id)) return false;
  return envIds().includes(String(id)) || Boolean(s.approved[String(id)]);
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

// Bans and denials are the same state: the user is ignored entirely, so they
// get no reply and the owners get no request.
function deny(id) {
  const s = load();
  const key = String(id);
  if (isOwner(key)) return null; // an owner cannot be banned
  const record = s.pending[key] || s.approved[key] || { id: key };
  delete s.pending[key];
  delete s.approved[key];
  s.denied[key] = { ...record, denied_at: new Date().toISOString() };
  save();
  return s.denied[key];
}

// Lifts a ban. The user is not re-approved — they simply become a stranger
// again, free to send /start and have that request reach the owners.
function unban(id) {
  const s = load();
  const key = String(id);
  if (!s.denied[key]) return false;
  delete s.denied[key];
  save();
  return true;
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

// Defaults to 0: a newly approved user can spend nothing until an owner funds
// them with /add. That makes access and spending two separate decisions, so
// approving someone can never by itself put the balance at risk.
const DEFAULT_LIMIT_MINOR = (() => {
  const raw = process.env.TELEGRAM_DEFAULT_DAILY_LIMIT;
  if (raw === undefined || raw === '') return 0;
  if (/^(none|unlimited|0+(\.0+)?)$/i.test(String(raw).trim())) {
    return /^(none|unlimited)$/i.test(String(raw).trim()) ? null : 0;
  }
  const cents = Math.round(Number(raw) * 100);
  return Number.isFinite(cents) && cents >= 0 ? cents : 0;
})();

// With no daily cap configured, allowance comes purely from granted balance —
// a wallet rather than a rate limit. Worth distinguishing, because the wording
// shown to users is quite different.
function isWalletMode(id) {
  return getLimit(id) === 0;
}

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

// ---------- Top-up credit ----------
// Credit is a one-off grant that does NOT reset daily. It is spent only after
// the day's allowance is used up, so /add tops someone up without permanently
// raising their cap.

function getCredit(id) {
  return Math.max(0, Number(load().credits[String(id)]) || 0);
}

function addCredit(id, minor) {
  const s = load();
  const key = String(id);
  const next = Math.max(0, getCredit(key) + Math.round(Number(minor) || 0));
  s.credits[key] = next;
  save();
  return next;
}

// Every cent of granted credit is a claim on the one shared JuicySMS balance,
// so grants are validated against the sum, not against each user in isolation.
function totalCredit() {
  const s = load();
  return Object.values(s.credits).reduce((sum, v) => sum + Math.max(0, Number(v) || 0), 0);
}

function setCredit(id, minor) {
  const s = load();
  s.credits[String(id)] = Math.max(0, Math.round(Number(minor) || 0));
  save();
  return s.credits[String(id)];
}

// Room left in the daily allowance alone, ignoring credit.
function dailyRoom(id) {
  const limit = getLimit(id);
  if (limit === null) return null;
  return Math.max(0, limit - todaySpend(id));
}

// null means unlimited remaining. Otherwise: what is left of today's cap, plus
// any credit that has been granted.
function remaining(id) {
  const room = dailyRoom(id);
  if (room === null) return null;
  return room + getCredit(id);
}

// Spends against the day's allowance first, then credit. Returns the split so
// a later release can reverse it exactly.
function addSpend(id, minor) {
  const amount = Math.max(0, Math.round(Number(minor) || 0));
  if (!amount) return { fromDaily: 0, fromCredit: 0 };

  const room = dailyRoom(id);
  const fromDaily = room === null ? amount : Math.min(amount, room);
  const fromCredit = amount - fromDaily;

  if (fromDaily) {
    const s = load();
    const key = String(id);
    const rec = s.spend[key];
    s.spend[key] = rec && rec.date === today()
      ? { date: rec.date, minor: (Number(rec.minor) || 0) + fromDaily }
      : { date: today(), minor: fromDaily };
    save();
  }
  if (fromCredit) addCredit(id, -fromCredit);

  return { fromDaily, fromCredit };
}

// An order that ends with no SMS is never charged, so the reservation is
// released — each part back to where it came from.
function refundSpend(id, split) {
  // Tolerates being handed a plain amount, which is treated as daily spend.
  const parts = typeof split === 'object' && split !== null
    ? split
    : { fromDaily: Math.round(Number(split) || 0), fromCredit: 0 };

  const daily = Math.max(0, Number(parts.fromDaily) || 0);
  const credit = Math.max(0, Number(parts.fromCredit) || 0);

  if (credit) addCredit(id, credit);
  if (daily) {
    const s = load();
    const rec = s.spend[String(id)];
    if (rec && rec.date === today()) {
      rec.minor = Math.max(0, (Number(rec.minor) || 0) - daily);
      save();
    }
  }
  return remaining(id);
}

function eur(minor) {
  if (minor === null || minor === undefined) return 'unlimited';
  return '€' + (Number(minor) / 100).toFixed(2);
}

module.exports = {
  init, load, ownerId, ownerIds, isOwner, claimOwner, isApproved, isDenied, isPending,
  requestAccess, approve, deny, unban, revoke, list, describe,
  getLimit, setLimit, todaySpend, remaining, addSpend, refundSpend, eur,
  getCredit, addCredit, setCredit, dailyRoom, totalCredit, isWalletMode,
  DEFAULT_LIMIT_MINOR,
};
