const path = require('path');
// Resolve .env next to this file, so the panel works no matter which directory
// it is launched from.
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
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

// ---------- Optional login gate ----------
// Only armed when both PANEL_USER and PANEL_PASS are set, so local dev stays
// frictionless while a deployed panel can be locked down.
const PANEL_USER = process.env.PANEL_USER;
const PANEL_PASS = process.env.PANEL_PASS;

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

if (PANEL_USER && PANEL_PASS) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ')) {
      const [user, pass] = Buffer.from(header.slice(6), 'base64').toString().split(':');
      if (safeEqual(user || '', PANEL_USER) && safeEqual(pass || '', PANEL_PASS)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="OTP Panel"');
    res.status(401).send('Authentication required.');
  });
}

// ---------- JuicySMS client ----------
// The API key never leaves the server; the browser only ever talks to /api/*.
async function juicy(endpoint, { method = 'GET', body, query } = {}) {
  const url = new URL(API_BASE + endpoint);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }

  const init = {
    method,
    headers: {
      Authorization: 'Bearer ' + API_KEY,
      Accept: 'application/json',
    },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    return {
      status: 502,
      data: {
        code: 'upstream_unreachable',
        title: 'Could not reach JuicySMS',
        detail: err.message,
        retryable: true,
      },
    };
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { code: 'bad_gateway', title: 'Unexpected response', detail: text.slice(0, 300) };
  }

  const rate = {
    limit: res.headers.get('x-ratelimit-limit'),
    remaining: res.headers.get('x-ratelimit-remaining'),
    reset: res.headers.get('x-ratelimit-reset'),
  };
  return { status: res.status, data, rate };
}

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
  if (PANEL_USER && PANEL_PASS) console.log('Login gate: enabled');
});
