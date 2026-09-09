const path = require('path');
// Resolve .env next to this file, so the panel works no matter which directory
// it is launched from.
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3200;
const API_BASE = process.env.JUICYSMS_API_BASE || 'https://juicysms.com/api/v2';
const API_KEY = process.env.JUICYSMS_API_KEY;

if (!API_KEY) {
  console.error('Missing JUICYSMS_API_KEY in .env — the panel will start but every call will fail.');
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
// The login form posts as urlencoded, so this must be registered before it.
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

// ---------- Login gate ----------
// Armed whenever PANEL_PASS is set. Everything behind it — the UI, the static
// assets, and every /api route that can spend money — requires a session.
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS;
const AUTH_ENABLED = Boolean(PANEL_PASS);

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

app.use(
  session({
    name: 'otp_panel_sid',
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto', // HTTPS-only once behind a proxy that sets X-Forwarded-Proto
      maxAge: 12 * 60 * 60 * 1000,
    },
  })
);

// Simple in-memory throttle: an exposed panel guards real money, so brute
// forcing the password should not be cheap.
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map();

function attemptKey(req) {
  return req.ip || 'unknown';
}

function isLockedOut(req) {
  const record = attempts.get(attemptKey(req));
  if (!record) return false;
  if (Date.now() > record.until) {
    attempts.delete(attemptKey(req));
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function noteFailure(req) {
  const key = attemptKey(req);
  const record = attempts.get(key) || { count: 0, until: 0 };
  record.count += 1;
  record.until = Date.now() + LOCKOUT_MS;
  attempts.set(key, record);
}

function loginPage({ error } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in — OTP Panel</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>📮</text></svg>" />
<style>
  :root { --bg:#0d1017; --elev:#151a24; --line:#232b3b; --text:#e7ecf5; --muted:#8b98ad; --accent:#ff9f43; --err:#ff6b6b; }
  * { box-sizing: border-box; }
  body {
    margin:0; min-height:100vh; display:grid; place-items:center; padding:24px;
    background: radial-gradient(900px 500px at 20% -10%, #1d2432 0%, transparent 60%),
                radial-gradient(700px 400px at 100% 0%, #241d17 0%, transparent 55%), var(--bg);
    color: var(--text); font:15px/1.55 "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
  }
  .box { width:100%; max-width:360px; background:var(--elev); border:1px solid var(--line);
         border-radius:14px; padding:28px; box-shadow:0 8px 30px rgba(0,0,0,.35); }
  .mark { font-size:26px; width:48px; height:48px; display:grid; place-items:center; border-radius:13px;
          background:linear-gradient(140deg,#2a2113,#1a1f2b); border:1px solid var(--line); margin-bottom:16px; }
  h1 { margin:0 0 4px; font-size:19px; }
  p.sub { margin:0 0 22px; color:var(--muted); font-size:13px; }
  label { display:block; margin-bottom:6px; font-size:12px; text-transform:uppercase;
          letter-spacing:.07em; color:var(--muted); }
  input { width:100%; padding:10px 12px; margin-bottom:16px; background:#1b2130; color:var(--text);
          border:1px solid var(--line); border-radius:10px; font:inherit; outline:none; }
  input:focus { border-color:var(--accent); box-shadow:0 0 0 3px rgba(255,159,67,.14); }
  button { width:100%; padding:11px; border:0; border-radius:10px; font:inherit; font-weight:700;
           color:#1a1206; background:linear-gradient(135deg,var(--accent),#ff7f2a); cursor:pointer; }
  button:hover { filter:brightness(1.08); }
  .err { background:rgba(255,107,107,.1); border:1px solid rgba(255,107,107,.35); color:var(--err);
         padding:10px 12px; border-radius:10px; margin-bottom:16px; font-size:13px; }
</style>
</head>
<body>
  <form class="box" method="POST" action="/login">
    <div class="mark">📮</div>
    <h1>OTP Panel</h1>
    <p class="sub">Sign in to continue</p>
    ${error ? `<div class="err">${error}</div>` : ''}
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" autofocus required />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required />
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

app.get('/login', (req, res) => {
  if (!AUTH_ENABLED || (req.session && req.session.user)) return res.redirect('/');
  res.type('html').send(loginPage());
});

app.post('/login', (req, res) => {
  if (!AUTH_ENABLED) return res.redirect('/');

  if (isLockedOut(req)) {
    return res.status(429).type('html').send(
      loginPage({ error: 'Too many attempts. Try again in 15 minutes.' })
    );
  }

  const { username, password } = req.body || {};
  const ok = safeEqual(username || '', PANEL_USER) && safeEqual(password || '', PANEL_PASS);

  if (!ok) {
    noteFailure(req);
    // Deliberately vague: never reveal which half was wrong.
    return res.status(401).type('html').send(loginPage({ error: 'Incorrect username or password.' }));
  }

  attempts.delete(attemptKey(req));
  // New session id on login, so a fixated cookie cannot be reused.
  req.session.regenerate((err) => {
    if (err) return res.status(500).type('html').send(loginPage({ error: 'Could not start a session.' }));
    req.session.user = PANEL_USER;
    res.redirect('/');
  });
});

app.post('/logout', (req, res) => {
  if (!req.session) return res.redirect('/login');
  req.session.destroy(() => {
    res.clearCookie('otp_panel_sid');
    res.redirect('/login');
  });
});

// Public on purpose: it is the only way to confirm which commit a host is
// actually running without signing in. Exposes a version string and nothing else.
const APP_VERSION = require('./package.json').version;
const BUILD_TAG = 'auto-deploy-check-1';
const STARTED_AT = new Date().toISOString();

app.get('/api/version', (req, res) => {
  res.json({ version: APP_VERSION, build: BUILD_TAG, started_at: STARTED_AT });
});

app.get('/api/session', (req, res) => {
  res.json({
    auth_enabled: AUTH_ENABLED,
    user: req.session && req.session.user ? req.session.user : null,
  });
});

// ---------- Telegram webhook ----------
// Must sit before the login guard: Telegram cannot hold a session. It is
// protected instead by an unguessable path segment plus Telegram's own secret
// header, and the bot itself only obeys allowlisted user ids.
const telegram = require('./telegram');
const TG_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

app.post('/telegram/webhook/:secret', (req, res) => {
  if (!TG_WEBHOOK_SECRET || req.params.secret !== TG_WEBHOOK_SECRET) {
    return res.status(404).json({ code: 'not_found' });
  }
  const header = req.get('X-Telegram-Bot-Api-Secret-Token');
  if (header && header !== TG_WEBHOOK_SECRET) {
    return res.status(403).json({ code: 'bad_secret' });
  }

  // Acknowledge immediately — Telegram retries anything slower than ~60s, and
  // ordering a number can take longer than that.
  res.json({ ok: true });
  telegram.handleUpdate(req.body).catch((err) => console.error('telegram update failed:', err));
});

// The guard itself. Registered before every route that follows, so static
// assets and API routes alike are unreachable without a session.
app.use((req, res, next) => {
  if (!AUTH_ENABLED || (req.session && req.session.user)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ code: 'not_signed_in', title: 'Sign in required' });
  }
  res.redirect('/login');
});

// ---------- JuicySMS client ----------
// Shared with the Telegram bot; the API key never leaves the server.
const { juicy } = require('./juicysms');

// Forwards upstream status codes untouched so the UI can react to
// out_of_stock / insufficient_balance / rate_limited by code.
function forward(res, result) {
  if (result.rate && result.rate.limit) {
    res.set('X-Upstream-RateLimit-Limit', result.rate.limit);
    res.set('X-Upstream-RateLimit-Remaining', result.rate.remaining || '');
  }
  res.status(result.status).json(result.data);
}

const wrap = (handler) => (req, res) => {
  handler(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ code: 'panel_error', title: 'Panel error', detail: err.message });
  });
};

// ---------- Account ----------
app.get('/api/account', wrap(async (req, res) => {
  forward(res, await juicy('/account'));
}));

// ---------- Services ----------
app.get('/api/services', wrap(async (req, res) => {
  forward(res, await juicy('/services', {
    query: { country: req.query.country, search: req.query.search },
  }));
}));

// ---------- Orders ----------
app.post('/api/orders', wrap(async (req, res) => {
  const { country, service_id, max_price } = req.body || {};
  if (!country || !service_id) {
    return res.status(422).json({
      code: 'validation_failed',
      title: 'Missing fields',
      detail: 'Both country and service_id are required.',
    });
  }
  const body = { country, service_id: Number(service_id) };
  if (max_price !== undefined && max_price !== '' && max_price !== null) {
    body.max_price = String(max_price);
  }
  forward(res, await juicy('/orders', { method: 'POST', body }));
}));

app.get('/api/orders', wrap(async (req, res) => {
  forward(res, await juicy('/orders', {
    query: {
      status: req.query.status,
      limit: req.query.limit,
      cursor: req.query.cursor,
      service_id: req.query.service_id,
      created_after: req.query.created_after,
      created_before: req.query.created_before,
    },
  }));
}));

app.get('/api/orders/:id', wrap(async (req, res) => {
  forward(res, await juicy('/orders/' + encodeURIComponent(req.params.id)));
}));

app.get('/api/orders/:id/messages', wrap(async (req, res) => {
  forward(res, await juicy('/orders/' + encodeURIComponent(req.params.id) + '/messages'));
}));

for (const action of ['cancel', 'skip', 'reuse']) {
  app.post('/api/orders/:id/' + action, wrap(async (req, res) => {
    forward(res, await juicy('/orders/' + encodeURIComponent(req.params.id) + '/' + action, { method: 'POST' }));
  }));
}

// ---------- Rentals ----------
app.get('/api/rental-packages', wrap(async (req, res) => {
  forward(res, await juicy('/rental-packages'));
}));

app.post('/api/rentals', wrap(async (req, res) => {
  const { country, package: pkg, auto_renew } = req.body || {};
  if (!country || !pkg) {
    return res.status(422).json({
      code: 'validation_failed',
      title: 'Missing fields',
      detail: 'Both country and package are required.',
    });
  }
  forward(res, await juicy('/rentals', {
    method: 'POST',
    body: { country, package: pkg, auto_renew: Boolean(auto_renew) },
  }));
}));

app.get('/api/rentals', wrap(async (req, res) => {
  forward(res, await juicy('/rentals', {
    query: { status: req.query.status, limit: req.query.limit, cursor: req.query.cursor },
  }));
}));

app.get('/api/rentals/:id', wrap(async (req, res) => {
  forward(res, await juicy('/rentals/' + encodeURIComponent(req.params.id)));
}));

app.get('/api/rentals/:id/messages', wrap(async (req, res) => {
  forward(res, await juicy('/rentals/' + encodeURIComponent(req.params.id) + '/messages'));
}));

app.patch('/api/rentals/:id', wrap(async (req, res) => {
  const body = {};
  if (req.body && 'auto_renew' in req.body) body.auto_renew = Boolean(req.body.auto_renew);
  if (req.body && req.body.renewal_package) body.renewal_package = req.body.renewal_package;
  forward(res, await juicy('/rentals/' + encodeURIComponent(req.params.id), { method: 'PATCH', body }));
}));

app.post('/api/rentals/:id/extend', wrap(async (req, res) => {
  const pkg = (req.body || {}).package;
  if (!pkg) {
    return res.status(422).json({ code: 'validation_failed', title: 'Missing package', detail: 'package is required.' });
  }
  forward(res, await juicy('/rentals/' + encodeURIComponent(req.params.id) + '/extend', {
    method: 'POST',
    body: { package: pkg },
  }));
}));

// ---------- FX (EUR -> USD) ----------
// JuicySMS prices and charges strictly in EUR, so USD is a display-only
// convenience. Rates are cached for an hour; a failure is not fatal — the UI
// simply falls back to showing EUR alone.
const FX_TTL_MS = 60 * 60 * 1000;
let fxCache = { rate: null, as_of: null, source: null, fetched_at: 0 };

async function fetchRate() {
  // Primary: ECB reference rates via Frankfurter.
  try {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD', {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.rates && data.rates.USD) {
        return { rate: data.rates.USD, as_of: data.date, source: 'ECB via frankfurter.dev' };
      }
    }
  } catch { /* fall through to the backup source */ }

  try {
    const res = await fetch('https://open.er-api.com/v6/latest/EUR', {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.rates && data.rates.USD) {
        return {
          rate: data.rates.USD,
          as_of: (data.time_last_update_utc || '').slice(5, 16),
          source: 'exchangerate-api.com',
        };
      }
    }
  } catch { /* no rate available */ }

  return null;
}

app.get('/api/fx', wrap(async (req, res) => {
  if (fxCache.rate && Date.now() - fxCache.fetched_at < FX_TTL_MS) {
    return res.json({ ...fxCache, cached: true });
  }
  const fresh = await fetchRate();
  if (fresh) {
    fxCache = { ...fresh, fetched_at: Date.now() };
    return res.json({ ...fxCache, cached: false });
  }
  // Serve a stale rate rather than nothing, if we ever had one.
  if (fxCache.rate) return res.json({ ...fxCache, cached: true, stale: true });
  res.status(503).json({ code: 'fx_unavailable', title: 'No exchange rate available' });
}));

// ---------- Panel meta ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, key_configured: Boolean(API_KEY), api_base: API_BASE });
});

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ code: 'not_found', title: 'No such panel route' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('OTP panel running on http://localhost:' + PORT);
  if (telegram.start()) {
    const owners = telegram.users.ownerIds();
    console.log(
      'Telegram bot: ENABLED — owner(s): ' + (owners.length ? owners.join(', ') : 'unclaimed (first /start claims it)')
    );
    if (!TG_WEBHOOK_SECRET) {
      console.warn('TELEGRAM_WEBHOOK_SECRET is not set — the webhook route is disabled.');
    }
  }
  if (AUTH_ENABLED) {
    console.log('Login gate: ENABLED (user "' + PANEL_USER + '")');
    if (!process.env.SESSION_SECRET) {
      console.warn('No SESSION_SECRET set — sessions will not survive a restart.');
    }
  } else {
    console.warn('');
    console.warn('  WARNING: no PANEL_PASS set — this panel is COMPLETELY OPEN.');
    console.warn('  Anyone who reaches this URL can order numbers and spend your balance.');
    console.warn('  Set PANEL_USER and PANEL_PASS before hosting it anywhere public.');
    console.warn('');
  }
});
