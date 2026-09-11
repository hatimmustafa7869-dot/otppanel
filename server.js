const path = require('path');
// Resolve .env next to this file, so the panel works no matter which directory
// it is launched from.
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3200;
const API_KEY = process.env.SMSOTPS_API_KEY;

if (!API_KEY) {
  console.error('Missing SMSOTPS_API_KEY in .env — the panel will start but every call will fail.');
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
const BUILD_TAG = 'persistence-test';
const STARTED_AT = new Date().toISOString();

app.get('/api/version', (req, res) => {
  // Readable cross-origin on purpose: the portfolio polls this to show whether
  // the panel is actually up. The body is already public and holds no secrets.
  res.set('Access-Control-Allow-Origin', '*');
  // Storage kind and durability are reported so a deploy can be checked from
  // outside — "is state actually surviving?" is otherwise invisible until
  // something is already lost. No path or credentials are exposed.
  res.json({
    version: APP_VERSION,
    build: BUILD_TAG,
    started_at: STARTED_AT,
    storage: require('./store').status(),
  });
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

// ---------- smsotps client ----------
// Shared with the Telegram bot; the API key never leaves the server.
const sms = require('./smsotps');

const wrap = (handler) => (req, res) => {
  handler(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ code: 'panel_error', title: 'Panel error', detail: err.message });
  });
};

// Upstream status codes are passed through so the UI can react by code.
function forward(res, result) {
  res.status(result.status).json(result.data);
}

// ---------- Account ----------
app.get('/api/account', wrap(async (req, res) => {
  const { status, data, balance } = await sms.getBalance();
  if (status !== 200) return res.status(status).json(data);
  res.json({ balance, currency: sms.CURRENCY });
}));

// ---------- Catalog ----------
app.get('/api/providers', (req, res) => {
  res.json({ data: sms.PROVIDERS, default: sms.PROVIDERS[0] });
});

app.get('/api/services', wrap(async (req, res) => {
  const provider = req.query.provider || sms.PROVIDERS[0];
  if (!sms.providerOk(provider)) {
    return res.status(422).json({ code: 'bad_provider', title: 'Unknown provider' });
  }
  const search = String(req.query.search || '').trim().toLowerCase();
  let list = await sms.listServices(provider);
  if (search) list = list.filter((s) => s.name.toLowerCase().includes(search) || s.code === search);
  res.json({ data: list, provider });
}));

app.get('/api/countries', wrap(async (req, res) => {
  const provider = req.query.provider || sms.PROVIDERS[0];
  if (!sms.providerOk(provider)) {
    return res.status(422).json({ code: 'bad_provider', title: 'Unknown provider' });
  }
  const search = String(req.query.search || '').trim().toLowerCase();
  let list = await sms.listCountries(provider);
  if (search) list = list.filter((c) => c.name.toLowerCase().includes(search));
  res.json({ data: list, provider });
}));

// Prices are per provider + service + country, so the UI asks for them only
// once all three are chosen.
app.get('/api/offers', wrap(async (req, res) => {
  const { provider = sms.PROVIDERS[0], service, country } = req.query;
  if (!service || !country) {
    return res.status(422).json({ code: 'validation_failed', title: 'service and country are required' });
  }
  const { status, data, offers } = await sms.listOffers(provider, service, country);
  if (status !== 200) return res.status(status).json(data);
  res.json({ data: offers, provider, service, country });
}));

// ---------- Orders ----------
app.post('/api/orders', wrap(async (req, res) => {
  const { provider = sms.PROVIDERS[0], service, country, operator, max_price: maxPrice } = req.body || {};
  if (!service || !country) {
    return res.status(422).json({
      code: 'validation_failed',
      title: 'Missing fields',
      detail: 'Both service and country are required.',
    });
  }
  forward(res, await sms.createOrder({ provider, service, country, operator, maxPrice }));
}));

// Past orders come only from the undocumented /history, which is also the only
// place price and sms_code appear.
app.get('/api/orders', wrap(async (req, res) => {
  const { status, data, rows, pagination } = await sms.getHistory({ page: req.query.page || 1 });
  if (status !== 200) return res.status(status).json(data);
  res.json({ data: rows, pagination });
}));

app.get('/api/orders/:id', wrap(async (req, res) => {
  const { status, data, parsed } = await sms.getStatus(req.params.id);
  if (status !== 200) return res.status(status).json(data);
  res.json({ id: req.params.id, ...parsed, raw: data });
}));

app.post('/api/orders/:id/cancel', wrap(async (req, res) => {
  forward(res, await sms.cancelOrder(req.params.id));
}));

// The provider's own "another SMS on this number", which replaces the old reuse.
app.post('/api/orders/:id/resend', wrap(async (req, res) => {
  forward(res, await sms.resendSms(req.params.id));
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

const store = require('./store');

// Storage comes up before the port opens: handling a Telegram update with an
// empty user store would treat approved users as strangers.
(async () => {
  try {
    const where = await store.init();
    console.log('Store: ' + where);
    const migrated = await store.migrateFromFiles(['tg-users', 'watchers']);
    if (migrated.length) console.log('Store: imported from files -> ' + migrated.join(', '));
  } catch (err) {
    console.error('Store failed to start:', err.message);
    console.error(
      'Refusing to serve without durable storage — check DATA_DIR (must exist and be ' +
      'writable) or the MYSQL_* settings. Starting anyway would silently reset every ' +
      'approval and balance on each deploy.'
    );
    process.exit(1);
  }

  if (await telegram.start()) {
    const owners = telegram.users.ownerIds();
    console.log(
      'Telegram bot: ENABLED — owner(s): ' + (owners.length ? owners.join(', ') : 'unclaimed (first /start claims it)')
    );
    if (!TG_WEBHOOK_SECRET) {
      console.warn('TELEGRAM_WEBHOOK_SECRET is not set — the webhook route is disabled.');
    }
  }

  startServer();
})();

// Persist anything still debounced rather than losing the last write.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    store.flush().finally(() => process.exit(0));
  });
}

function startServer() {
  app.listen(PORT, () => {
  console.log('OTP panel running on http://localhost:' + PORT);
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
}
