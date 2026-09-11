// Shared smsotps.com API client, used by both the web panel and the Telegram bot.
//
// Verified against the live API on 2026-09-12. The published docs are wrong in
// three places, so trust this file over them:
//   * Catalogs are NOT on the API host. provider_*_services.json and
//     provider_*_countries.json are served from the main domain root.
//   * The offers endpoint returns an array of operators, each holding a list of
//     price tiers, not the documented flat {status, offers:[...]}.
//   * /history exists and is undocumented. It is the only source of past
//     orders, and unlike the rest of the API it carries price and sms_code.
const API_BASE = process.env.SMSOTPS_API_BASE || 'https://api.smsotps.com/api';
const CATALOG_BASE = process.env.SMSOTPS_CATALOG_BASE || 'https://smsotps.com';
const API_KEY = process.env.SMSOTPS_API_KEY;

// Balance and prices come back as bare decimal strings with no currency field.
// The account is denominated in USD.
const CURRENCY = 'USD';

// provider_c is bulk link-auth only and has no catalog files, so it is not offered.
const PROVIDERS = ['provider_a', 'provider_b', 'provider_d'];
const PROVIDER_PREFIX = { provider_a: 'p_a', provider_b: 'p_b', provider_d: 'p_d' };

function providerOk(p) {
  return PROVIDERS.includes(p);
}

async function call(endpoint, { method = 'GET', body, query } = {}) {
  const url = new URL(API_BASE + endpoint);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }

  const init = {
    method,
    headers: {
      'X-API-KEY': API_KEY,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(30000),
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
      data: { code: 'upstream_unreachable', title: 'Could not reach smsotps', detail: err.message },
    };
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { code: 'bad_gateway', title: 'Unexpected response', detail: text.slice(0, 300) };
  }

  // An unknown route on this API answers 405, which would otherwise read as a
  // confusing "method not allowed" rather than "that endpoint does not exist".
  if (res.status === 405) {
    return { status: 404, data: { code: 'not_found', title: 'No such endpoint', detail: endpoint } };
  }
  return { status: res.status, data };
}

// ---------- Catalogs ----------
// Static per provider and large, so they are cached rather than refetched.

const catalogCache = new Map(); // file -> { at, value }
const CATALOG_TTL_MS = 60 * 60 * 1000;

async function catalog(file) {
  const hit = catalogCache.get(file);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.value;
  try {
    const res = await fetch(CATALOG_BASE + '/' + file, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return hit ? hit.value : null;
    const value = await res.json();
    catalogCache.set(file, { at: Date.now(), value });
    return value;
  } catch {
    return hit ? hit.value : null; // stale beats nothing
  }
}

// [{ code: 'wa', name: 'Whatsapp' }]
async function listServices(provider) {
  if (!providerOk(provider)) return [];
  const raw = await catalog(provider + '_services.json');
  if (!raw) return [];
  return Object.entries(raw)
    .map(([code, name]) => ({ code, name: String(name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// [{ id: '16', name: 'United Kingdom', operators: [...] }]
async function listCountries(provider) {
  if (!providerOk(provider)) return [];
  const raw = await catalog(provider + '_countries.json');
  if (!raw) return [];
  return Object.entries(raw)
    .map(([id, v]) => ({ id: String(id), name: String(v.name), operators: v.operators || ['any'] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Flattens the tiered response to the cheapest in-stock price per operator:
// [{ operator, label, price, count }] sorted cheapest first.
async function listOffers(provider, service, country) {
  const prefix = PROVIDER_PREFIX[provider];
  if (!prefix) return { status: 400, data: { title: 'Unknown provider' }, offers: [] };

  const { status, data } = await call(
    '/' + prefix + '/offers/' + encodeURIComponent(service) + '/' + encodeURIComponent(country)
  );
  if (status !== 200 || !Array.isArray(data)) return { status, data, offers: [] };

  const offers = [];
  for (const op of data) {
    const tiers = (op.offers || []).filter((t) => Number(t.count) > 0);
    if (!tiers.length) continue;
    const cheapest = tiers.reduce((a, b) => (Number(a.price) <= Number(b.price) ? a : b));
    offers.push({
      operator: op.name,
      label: op.localName || op.name,
      price: Number(cheapest.price),
      count: tiers.reduce((sum, t) => sum + Number(t.count || 0), 0),
    });
  }
  offers.sort((a, b) => a.price - b.price);
  return { status: 200, data, offers };
}

// Cheapest available price for a service/country, or null when out of stock.
async function cheapestPrice(provider, service, country) {
  const { offers } = await listOffers(provider, service, country);
  return offers.length ? offers[0] : null;
}

// ---------- Account ----------

async function getBalance() {
  const { status, data } = await call('/balance');
  if (status !== 200) return { status, data, balance: null };
  return { status, data, balance: { amount: String(data.balance), currency: CURRENCY } };
}

// ---------- Orders ----------

async function createOrder({ provider, service, country, operator, maxPrice }) {
  const body = { provider, service, country: Number(country) };
  if (operator && operator !== 'any') body.operator = operator;
  if (maxPrice !== undefined && maxPrice !== null && maxPrice !== '') body.max_price = Number(maxPrice);
  return call('/order-number', { method: 'POST', body });
}

// The status endpoint answers in two shapes depending on the provider: an
// object, or a bare {status: "STATUS_OK:123456"} string. Normalise both.
function parseStatus(data) {
  if (!data || typeof data !== 'object') return { state: 'unknown', code: null, text: null };

  const raw = typeof data.status === 'string' ? data.status : '';
  if (raw.startsWith('STATUS_OK')) {
    const [, code] = raw.split(':');
    return { state: 'completed', code: code || data.sms_code || null, text: data.full_text || null };
  }
  if (raw === 'STATUS_CANCEL') return { state: 'cancelled', code: null, text: null };
  if (raw === 'STATUS_WAIT_CODE' || raw === 'STATUS_WAIT') {
    return { state: 'pending', code: null, text: null };
  }

  const code = data.sms_code || null;
  const text = data.full_text || data.raw_sms || null;
  const state = code ? 'completed' : (raw || data.state || 'pending').toLowerCase();
  return { state, code, text };
}

async function getStatus(id) {
  const { status, data } = await call('/number-status/' + encodeURIComponent(id));
  return { status, data, parsed: parseStatus(data) };
}

async function cancelOrder(id) {
  return call('/cancel-number/' + encodeURIComponent(id), { method: 'POST' });
}

// The provider's own "give me another SMS on this number" — the closest thing
// to the old reuse, and only valid while can_get_another_sms is set.
async function resendSms(id) {
  return call('/resend-sms/' + encodeURIComponent(id), { method: 'POST' });
}

// Undocumented, paginated, and the only source of past orders. Rows carry
// price and sms_code, which no other endpoint returns.
async function getHistory({ page = 1 } = {}) {
  const { status, data } = await call('/history', { query: { page } });
  if (status !== 200) return { status, data, rows: [], pagination: null };
  return {
    status,
    data,
    rows: data.data || [],
    pagination: {
      page: data.current_page,
      lastPage: data.last_page,
      total: data.total,
      perPage: data.per_page,
    },
  };
}

// ---------- Formatting ----------

function money(value) {
  const n = Number(
    value && typeof value === 'object' ? (value.amount !== undefined ? value.amount : value.price) : value
  );
  if (!isFinite(n)) return '—';
  return '$' + n.toFixed(2);
}

// Integer cents, so spending arithmetic never touches floats.
function toMinor(value) {
  const n = Number(value && typeof value === 'object' ? value.price : value);
  if (!isFinite(n)) return 0;
  return Math.round(n * 100);
}

// The provider usually returns a clean sms_code, but raw text is parsed when it
// does not. Carriers append an Android SMS Retriever app hash (11 chars) on its
// own line; providers that strip newlines glue it to the digits, and a naive
// parser then swallows its leading digits — a real WhatsApp message of
// "…code: 760-974" + "4sgLq1p5sV6" was once reported as "7609744".
function extractCode(text, fallback) {
  if (!text) return fallback || null;
  const clean = String(text).replace(/^<#>\s*/, '');

  const hyphen = clean.match(/(\d{3})-(\d{3})/);
  if (hyphen) return hyphen[1] + hyphen[2];

  const labelled = clean.match(/(?:code|otp|pin|password)\D{0,15}?(\d{4,8})/i);
  if (labelled) return labelled[1];

  const standalone = clean.match(/(?<![\dA-Za-z])(\d{4,8})(?![\dA-Za-z])/);
  if (standalone) return standalone[1];

  return fallback || null;
}

// Prefers the provider's own code, falling back to parsing the raw SMS.
function codeOf(row) {
  if (!row) return null;
  if (row.sms_code) return String(row.sms_code);
  return extractCode(row.raw_sms || row.full_text || row.text, null);
}

module.exports = {
  call, catalog, listServices, listCountries, listOffers, cheapestPrice,
  getBalance, createOrder, getStatus, cancelOrder, resendSms, getHistory,
  parseStatus, money, toMinor, extractCode, codeOf,
  PROVIDERS, CURRENCY, API_BASE, providerOk,
};
