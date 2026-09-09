// Shared JuicySMS API v2 client. Used by both the web panel's /api proxy and
// the Telegram bot, so there is exactly one place that talks to the upstream.
const API_BASE = process.env.JUICYSMS_API_BASE || 'https://juicysms.com/api/v2';
const API_KEY = process.env.JUICYSMS_API_KEY;

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

// The live API is inconsistent about where a price lives: services use `price`,
// rental packages use `your_price`/`list_price`, orders carry none at all.
function priceObj(value) {
  if (!value) return null;
  const price = value.amount ? value : (value.price || value.your_price || value.list_price);
  return price && price.amount ? price : null;
}

function money(value) {
  const price = priceObj(value);
  return price ? '€' + price.amount : '—';
}

// JuicySMS's own `code` field is unreliable. Carriers append an Android SMS
// Retriever app hash (11 chars) on its own line, the API strips newlines, and
// their extractor swallows the hash's leading digits — a real WhatsApp message
// of "…code: 760-974" + "4sgLq1p5sV6" was reported as code "7609744".
function extractCode(text, fallback) {
  if (!text) return fallback || null;
  const clean = String(text).replace(/^<#>\s*/, '');

  // Hyphenated 3-3 (WhatsApp, Google). Deliberately does NOT require a trailing
  // boundary, so a glued app hash cannot bleed into the digits.
  const hyphen = clean.match(/(\d{3})-(\d{3})/);
  if (hyphen) return hyphen[1] + hyphen[2];

  const labelled = clean.match(/(?:code|otp|pin|password)\D{0,15}?(\d{4,8})/i);
  if (labelled) return labelled[1];

  const standalone = clean.match(/(?<![\dA-Za-z])(\d{4,8})(?![\dA-Za-z])/);
  if (standalone) return standalone[1];

  return fallback || null;
}

function codeOf(message) {
  return message ? extractCode(message.text, message.code) : null;
}

module.exports = { juicy, money, priceObj, extractCode, codeOf, API_BASE };
