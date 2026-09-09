#!/usr/bin/env node
// Registers (or inspects/removes) the Telegram webhook for this panel.
//
//   node scripts/telegram-setup.js            show current webhook status
//   node scripts/telegram-setup.js set        point Telegram at PUBLIC_URL
//   node scripts/telegram-setup.js delete     stop receiving updates
//
// Reads TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and PUBLIC_URL from .env,
// so the token stays on your machine.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const API = 'https://api.telegram.org/bot' + TOKEN;

function bail(msg) {
  console.error('✖ ' + msg);
  process.exit(1);
}

async function call(method, body) {
  const res = await fetch(API + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

(async () => {
  if (!TOKEN) bail('TELEGRAM_BOT_TOKEN is not set in .env');

  const action = (process.argv[2] || 'status').toLowerCase();

  const me = await call('getMe');
  if (!me.ok) bail('Token rejected by Telegram: ' + (me.description || 'unknown error'));
  console.log('Bot: @' + me.result.username + ' (' + me.result.first_name + ')');

  if (action === 'status') {
    const info = await call('getWebhookInfo');
    const r = info.result || {};
    console.log('Webhook URL      :', r.url || '(none)');
    console.log('Pending updates  :', r.pending_update_count || 0);
    if (r.last_error_message) {
      console.log('Last error       :', r.last_error_message, '(' + new Date(r.last_error_date * 1000).toISOString() + ')');
    }
    return;
  }

  if (action === 'delete') {
    const out = await call('deleteWebhook', { drop_pending_updates: false });
    console.log(out.ok ? '✔ Webhook removed' : '✖ ' + out.description);
    return;
  }

  if (action === 'set') {
    if (!PUBLIC_URL) bail('PUBLIC_URL is not set in .env (e.g. https://otp.trustedhits.com)');
    if (!SECRET) bail('TELEGRAM_WEBHOOK_SECRET is not set in .env');
    if (!PUBLIC_URL.startsWith('https://')) bail('Telegram requires an HTTPS URL');

    const url = PUBLIC_URL + '/telegram/webhook/' + SECRET;
    const out = await call('setWebhook', {
      url,
      secret_token: SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    });
    if (!out.ok) bail('setWebhook failed: ' + out.description);
    console.log('✔ Webhook set to ' + PUBLIC_URL + '/telegram/webhook/***');

    const info = await call('getWebhookInfo');
    if (info.result && info.result.last_error_message) {
      console.log('  note: Telegram reports a previous error:', info.result.last_error_message);
    }
    return;
  }

  bail('Unknown action "' + action + '". Use status, set or delete.');
})().catch((err) => bail(err.message));
