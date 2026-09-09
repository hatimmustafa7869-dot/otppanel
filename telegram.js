// Telegram bot for the OTP panel.
//
// Runs as a webhook rather than long polling: the panel is already on public
// HTTPS, and shared hosting is a poor place to keep a polling loop alive.
//
// Every command that can spend money is gated on an explicit allowlist of
// Telegram user ids — the bot's username is discoverable, so without that
// anyone who finds it could order numbers against the account balance.
const { juicy, money, codeOf } = require('./juicysms');
const users = require('./tg-users');
const backend = require('./store');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_API = 'https://api.telegram.org/bot' + BOT_TOKEN;
const WATCH_KEY = 'watchers';
const POLL_MS = 5000;
const MAX_WATCH_MS = 11 * 60 * 1000; // orders expire after 10 minutes

const COUNTRIES = {
  uk: 'UK', gb: 'UK', britain: 'UK', england: 'UK',
  usa: 'USA', us: 'USA', america: 'USA',
  nl: 'NL', netherlands: 'NL', holland: 'NL',
  de: 'DE', germany: 'DE',
  pl: 'PL', poland: 'PL',
  ph: 'PH', philippines: 'PH',
};

// ---------- Telegram transport ----------

async function tg(method, payload) {
  try {
    const res = await fetch(TG_API + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    if (!data.ok) console.error('Telegram ' + method + ' failed:', data.description);
    return data;
  } catch (err) {
    console.error('Telegram ' + method + ' error:', err.message);
    return { ok: false };
  }
}

function send(chatId, text, extra = {}) {
  return tg('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return 'the start';
  return d.toISOString().slice(0, 10);
}

// Telegram renders HTML, so anything interpolated from an SMS must be escaped.
function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------- Pending-order watchers ----------
// Persisted so a restart (redeploy, idle recycle on shared hosting) does not
// silently drop an order that is still waiting for its SMS.

let watchers = new Map();

async function loadWatchers() {
  const raw = await backend.read(WATCH_KEY);
  watchers = new Map((Array.isArray(raw) ? raw : []).map((w) => [String(w.orderId), w]));
}

function saveWatchers() {
  backend.write(WATCH_KEY, [...watchers.values()]);
}

function watchOrder(orderId, chatId, label, userId, priceMinor, split, meta) {
  watchers.set(String(orderId), {
    orderId: String(orderId),
    chatId,
    label,
    userId: userId === undefined ? null : String(userId),
    priceMinor: Number(priceMinor) || 0,
    // How the reservation was funded, so a release reverses it exactly.
    split: split || { fromDaily: Number(priceMinor) || 0, fromCredit: 0 },
    // Service and country, so a skip can order the same thing again.
    meta: meta || null,
    startedAt: Date.now(),
  });
  saveWatchers();
}

// An order that ends without an SMS is never charged, so give the reservation
// back — daily to daily, credit to credit.
function releaseReservation(w) {
  if (!w || !w.userId) return;
  const split = w.split || { fromDaily: w.priceMinor || 0, fromCredit: 0 };
  if (split.fromDaily || split.fromCredit) users.refundSpend(w.userId, split);
}

function unwatch(orderId) {
  watchers.delete(String(orderId));
  saveWatchers();
}

// One interval for all pending orders, rather than a timer per order.
async function tick() {
  if (!watchers.size) return;

  for (const w of [...watchers.values()]) {
    if (Date.now() - w.startedAt > MAX_WATCH_MS) {
      unwatch(w.orderId);
      releaseReservation(w);
      await send(w.chatId, '⌛ That number expired with no SMS. You were not charged.');
      continue;
    }

    const { status, data } = await juicy('/orders/' + w.orderId + '/messages');
    if (status !== 200) continue;

    const messages = data.data || [];
    if (messages.length) {
      const code = codeOf(messages[0]);
      unwatch(w.orderId);
      // The SMS arrived, so this order was actually billed — the only point at
      // which a reservation becomes real spending.
      if (w.userId) users.recordCharge(w.userId, w.priceMinor);
      await send(
        w.chatId,
        '✅ <b>Code received</b>' +
          (w.label ? ' — ' + esc(w.label) : '') +
          '\n\n<code>' + esc(code || '?') + '</code>\n\n' +
          '<i>' + esc(messages[0].text || '') + '</i>',
        {
          reply_markup: {
            inline_keyboard: [[{ text: '♻️ Reuse this number', callback_data: 'reuse:' + w.orderId }]],
          },
        }
      );
    } else if (data.order_status && data.order_status !== 'pending') {
      unwatch(w.orderId);
      releaseReservation(w); // finished with no message => not charged
      await send(w.chatId, 'That order is now <b>' + esc(data.order_status) + '</b>.');
    }
  }
}

// ---------- Broadcast ----------
// A broadcast cannot be recalled, so the text is previewed and confirmed before
// it goes anywhere. Pending drafts live in memory only and expire.

const pendingBroadcasts = new Map(); // ownerId -> { text, at }
const BROADCAST_TTL_MS = 10 * 60 * 1000;
const BROADCAST_GAP_MS = 60; // stay well inside Telegram's ~30 msg/sec

// Formatting for broadcasts, done safely: the text is HTML-escaped FIRST, so no
// tag an owner types can ever reach Telegram as markup, and only then is a small
// markdown subset translated into the tags Telegram allows. The markers require
// a word boundary so that snake_case identifiers and URLs containing
// underscores are left alone.
const MD_RULES = [
  [/(^|[\s(>])\*([^*\n]+?)\*(?=[\s).,!?:;]|$)/gm, '$1<b>$2</b>'],
  [/(^|[\s(>])_([^_\n]+?)_(?=[\s).,!?:;]|$)/gm, '$1<i>$2</i>'],
  [/(^|[\s(>])`([^`\n]+?)`(?=[\s).,!?:;]|$)/gm, '$1<code>$2</code>'],
];

function formatBroadcast(text) {
  let out = esc(text);
  for (const [pattern, replacement] of MD_RULES) out = out.replace(pattern, replacement);
  return out;
}

function broadcastRecipients(excludeId) {
  const { approved } = users.list();
  return approved
    .map((u) => String(u.id))
    .filter((id) => id !== String(excludeId) && !users.isDenied(id));
}

async function sendBroadcast(ownerChatId, ownerId) {
  const draft = pendingBroadcasts.get(String(ownerId));
  pendingBroadcasts.delete(String(ownerId));

  if (!draft || Date.now() - draft.at > BROADCAST_TTL_MS) {
    return send(ownerChatId, '⌛ That draft expired. Send <code>/broadcast</code> again.');
  }

  const targets = broadcastRecipients(ownerId);
  if (!targets.length) return send(ownerChatId, 'No approved users to send to.');

  let sent = 0;
  const failed = [];
  for (const id of targets) {
    const res = await send(id, '📢 <b>Message from the owner</b>\n\n' + formatBroadcast(draft.text));
    if (res && res.ok) sent += 1;
    else failed.push(id);
    await new Promise((r) => setTimeout(r, BROADCAST_GAP_MS));
  }

  return send(
    ownerChatId,
    '📢 <b>Broadcast sent</b>\n\n' +
      'Delivered: <b>' + sent + '</b> of ' + targets.length +
      (failed.length
        ? '\nFailed: ' + failed.length + ' — <i>' + failed.map((f) => esc(f)).join(', ') +
          '</i>\n<i>Usually means they blocked the bot or never opened a chat with it.</i>'
        : '')
  );
}

// ---------- Command helpers ----------

// The country is required: /services returns `price: null` without one, and a
// null price would otherwise be read as costing nothing.
async function findService(term, country) {
  const { status, data } = await juicy('/services', { query: { search: term, country } });
  if (status !== 200) return null;
  const list = data.data || [];
  if (!list.length) return null;
  // Prefer an exact name match over the first substring hit, so "google"
  // does not resolve to "Google Chat".
  const exact = list.find((s) => s.name.toLowerCase() === term.toLowerCase());
  return exact || list[0];
}

// Splits "whatsapp usa" into a service term and a country, treating the last
// word as a country only when it actually is one — so "/order google chat"
// still searches for "google chat".
function splitTermAndCountry(args, fallback = 'UK') {
  const parts = [...args];
  const last = (parts[parts.length - 1] || '').toLowerCase();
  if (parts.length > 1 && COUNTRIES[last]) {
    parts.pop();
    return { term: parts.join(' '), country: COUNTRIES[last] };
  }
  return { term: parts.join(' '), country: fallback };
}

// Places an order and starts watching it. Shared by /order and by skip, which
// re-orders automatically. Returns null on success, or a message already sent.
async function placeOrder(chatId, userId, svc, country) {
  const priceMinor = (svc.price && svc.price.amount_minor) || 0;

  // A price of zero means the lookup did not carry one. Refuse rather than
  // reserve nothing against the user's balance.
  if (!priceMinor) {
    return send(chatId, '❌ Could not determine the price for ' + esc(svc.name) + ' in ' + esc(country) + '. Order not placed.');
  }

  const left = users.remaining(userId);
  if (left !== null && priceMinor > left) {
    if (users.isWalletMode(userId)) {
      return send(
        chatId,
        '🚫 <b>Not enough balance.</b>\n\n' +
          esc(svc.name) + ' costs ' + esc(users.eur(priceMinor)) +
          ', your balance is ' + esc(users.eur(left)) + '.\n\n<i>Ask an owner to add balance.</i>'
      );
    }
    return send(
      chatId,
      '🚫 <b>Daily limit reached.</b>\n\n' +
        esc(svc.name) + ' costs ' + esc(users.eur(priceMinor)) + ', but you have ' +
        esc(users.eur(left)) + ' left today (limit ' + esc(users.eur(users.getLimit(userId))) + ').\n\n' +
        '<i>Resets at 00:00 UTC. An owner can raise it with /limit.</i>'
    );
  }

  const { status, data } = await juicy('/orders', {
    method: 'POST',
    body: { country, service_id: svc.id },
  });

  if (status === 409 && data.code === 'concurrent_order_limit') {
    return send(chatId, '⚠️ You already have an open order. Use <code>/status</code> or <code>/cancel</code> first.');
  }
  if (status === 409 && data.code === 'out_of_stock') {
    return send(chatId, '😕 Out of stock for ' + esc(svc.name) + ' in ' + esc(country) + '. Try another country.');
  }
  if (status === 402) {
    return send(chatId, '💸 Insufficient balance on the account. Balance: ' + esc(money(data.balance)));
  }
  if (status !== 201 && status !== 200) {
    return send(chatId, '❌ ' + esc(data.detail || data.title || 'Order failed.'));
  }

  const split = users.addSpend(userId, priceMinor);
  users.recordOrder(userId);
  watchOrder(data.id, chatId, svc.name + ' · ' + country, userId, priceMinor, split, {
    serviceId: svc.id,
    serviceName: svc.name,
    country,
  });

  const nowLeft = users.remaining(userId);
  await send(
    chatId,
    '📱 <b>' + esc(data.phone_number) + '</b>\n' +
      esc(svc.name) + ' · ' + esc(country) + '\n' +
      (nowLeft === null ? '' : '<i>' + esc(users.eur(nowLeft)) + ' left</i>\n') +
      '\n<i>Waiting for the SMS — I will send the code here.</i>',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🚫 Cancel', callback_data: 'cancel:' + data.id },
          { text: '⛔ Skip', callback_data: 'skip:' + data.id },
        ]],
      },
    }
  );
  return null;
}

// Skip on the real site cancels the number, blacklists it and hands you a
// fresh one — so do the same here rather than leaving the user with nothing.
async function skipAndReorder(chatId, userId, orderId) {
  const w = watchers.get(String(orderId));

  const { status, data } = await juicy('/orders/' + orderId + '/skip', { method: 'POST' });
  if (status !== 200 && status !== 201) {
    return send(chatId, '❌ ' + esc(data.detail || 'Could not skip.'));
  }
  unwatch(orderId);
  releaseReservation(w); // skipped before an SMS => never charged

  const meta = w && w.meta;
  if (!meta || !meta.serviceId) {
    return send(chatId, '⛔ Skipped that number.\n<i>Order again with /order.</i>');
  }

  await send(chatId, '⛔ Skipped — getting you another number…');

  const svc = await findService(meta.serviceName, meta.country);
  if (!svc) return send(chatId, '❌ Could not look up ' + esc(meta.serviceName) + ' again.');
  return placeOrder(chatId, userId, svc, meta.country);
}

async function openOrder() {
  const { status, data } = await juicy('/orders', { query: { status: 'pending', limit: 1 } });
  if (status !== 200) return null;
  return (data.data || [])[0] || null;
}

const HELP = [
  '<b>OTP Panel bot</b>',
  '',
  '<code>/order &lt;service&gt; [country]</code> — order a number (default UK)',
  '<code>/status</code> — current open order and its code',
  '<code>/cancel</code> — cancel the open order',
  '<code>/skip</code> — blacklist this number and get another',
  '<code>/reuse</code> — reorder the last number at half price',
  '<code>/price &lt;service&gt; [country]</code> — look up a price',
  '<code>/balance</code> — balance / your remaining allowance',
  '<code>/usage</code> — what you have spent today',
  '<code>/stats</code> — totals for orders and spending',
  '<code>/history</code> — recent orders',
  '',
  'Countries: uk, usa, nl, de, pl, ph',
  'Example: <code>/order whatsapp usa</code>',
].join('\n');

const OWNER_HELP = [
  '',
  '<b>Owner commands</b>',
  '<code>/pending</code> — access requests waiting on you',
  '<code>/users</code> — who has access',
  '<code>/revoke &lt;id&gt;</code> — remove someone’s access',
  '<code>/broadcast &lt;text&gt;</code> — message every approved user',
  '<code>/ban &lt;id&gt;</code> — ignore them completely',
  '<code>/unban &lt;id&gt;</code> — lift a ban',
  '<code>/limits</code> — everyone’s daily limit and spend',
  '<code>/limit &lt;id&gt; &lt;eur&gt;</code> — set a daily limit (<code>none</code> = unlimited)',
  '<code>/add &lt;id&gt; &lt;eur&gt;</code> — add balance on top of their daily limit',
  '<code>/rm &lt;id&gt; &lt;eur|all&gt;</code> — remove balance',
  '<code>/whoami</code> — your Telegram id',
].join('\n');

function userLabel(u) {
  const bits = [];
  if (u.name) bits.push(esc(u.name));
  if (u.username) bits.push('@' + esc(u.username));
  bits.push('<code>' + esc(u.id) + '</code>');
  return bits.join(' · ');
}

// Sends the owner an approve/deny prompt for a newly seen user.
async function notifyOwnerOfRequest(from) {
  // Every owner gets the prompt; whichever acts first settles it.
  for (const owner of users.ownerIds()) {
    await send(
      owner,
      '🔔 <b>Access request</b>\n\n' + userLabel(users.describe(from)) +
        '\n\n<i>' +
        (users.DEFAULT_LIMIT_MINOR === 0
          ? 'Approving alone lets them spend nothing — fund them afterwards with /add.'
          : 'Approving lets them order numbers, capped at ' +
            esc(users.eur(users.DEFAULT_LIMIT_MINOR)) + '/day. Change it with /limit.') +
        '</i>',
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: 'approve:' + from.id },
            { text: '⛔ Deny', callback_data: 'deny:' + from.id },
          ]],
        },
      }
    );
  }
}

// ---------- Command handling ----------

async function handleCommand(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.split('@')[0].toLowerCase();

  const owner = users.isOwner(msg.from.id);

  switch (cmd) {
    case '/start':
    case '/help':
      return send(chatId, HELP + (owner ? OWNER_HELP : ''));

    case '/whoami':
      return send(chatId, 'Your Telegram id is <code>' + esc(msg.from.id) + '</code>' + (owner ? ' (owner)' : ''));

    case '/pending': {
      if (!owner) return send(chatId, 'Owner only.');
      const { pending } = users.list();
      if (!pending.length) return send(chatId, 'No pending requests.');
      for (const u of pending) {
        await send(chatId, '⏳ ' + userLabel(u), {
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Approve', callback_data: 'approve:' + u.id },
              { text: '⛔ Deny', callback_data: 'deny:' + u.id },
            ]],
          },
        });
      }
      return;
    }

    case '/users': {
      if (!owner) return send(chatId, 'Owner only.');
      const { approved, pending, denied, ownerIds } = users.list();
      const lines = ['<b>Access</b>', ''];
      lines.push('👑 Owners: ' + ownerIds.map((id) => '<code>' + esc(id) + '</code>').join(', '));
      lines.push('');
      lines.push('✅ Approved (' + approved.length + ')');
      approved.forEach((u) => lines.push('  • ' + userLabel(u)));
      if (pending.length) {
        lines.push('', '⏳ Pending (' + pending.length + ') — use /pending');
        pending.forEach((u) => lines.push('  • ' + userLabel(u)));
      }
      if (denied.length) {
        lines.push('', '🔨 Banned (' + denied.length + ') — /unban to lift');
        denied.forEach((u) => lines.push('  • ' + userLabel(u)));
      }
      return send(chatId, lines.join('\n'));
    }

    case '/broadcast': {
      if (!owner) return send(chatId, 'Owner only.');
      const body = text.slice(rawCmd.length).trim();
      if (!body) {
        return send(chatId, 'Usage: <code>/broadcast Your message here</code>\n\n' +
          'Formatting: <code>*bold*</code>, <code>_italic_</code>, <code>`code`</code>\n\n' +
          '<i>You will see a preview and confirm before anything is sent.</i>');
      }

      const targets = broadcastRecipients(msg.from.id);
      if (!targets.length) return send(chatId, 'No approved users to send to.');

      pendingBroadcasts.set(String(msg.from.id), { text: body, at: Date.now() });

      return send(
        chatId,
        '📢 <b>Preview</b> — this will go to <b>' + targets.length + '</b> user' +
          (targets.length === 1 ? '' : 's') + ':\n\n' +
          '━━━━━━━━━━\n' + formatBroadcast(body) + '\n━━━━━━━━━━\n\n' +
          '<i>Broadcasts cannot be recalled.</i>',
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '📢 Send to ' + targets.length, callback_data: 'bcast:send' },
              { text: '✖️ Cancel', callback_data: 'bcast:cancel' },
            ]],
          },
        }
      );
    }

    case '/ban': {
      if (!owner) return send(chatId, 'Owner only.');
      if (!args.length) return send(chatId, 'Usage: <code>/ban 123456789</code>');
      const target = args[0];
      if (users.isOwner(target)) return send(chatId, 'You cannot ban an owner.');

      const banned = users.deny(target);
      if (!banned) return send(chatId, 'Could not ban <code>' + esc(target) + '</code>.');
      // Deliberately silent towards the banned user: they should simply find
      // that the bot no longer answers, not learn they were banned.
      return send(
        chatId,
        '🔨 <b>Banned</b> <code>' + esc(target) + '</code>\n\n' +
          '<i>They are ignored from now on — no replies, and no approval request reaches you. ' +
          'Undo with /unban.</i>'
      );
    }

    case '/unban': {
      if (!owner) return send(chatId, 'Owner only.');
      if (!args.length) return send(chatId, 'Usage: <code>/unban 123456789</code>');
      const target = args[0];
      if (!users.unban(target)) return send(chatId, '<code>' + esc(target) + '</code> is not banned.');
      return send(
        chatId,
        '♻️ <b>Unbanned</b> <code>' + esc(target) + '</code>\n\n' +
          '<i>They still have no access — if they send /start you will get an approval request again.</i>'
      );
    }

    case '/revoke': {
      if (!owner) return send(chatId, 'Owner only.');
      if (!args.length) return send(chatId, 'Usage: <code>/revoke 123456789</code>');
      const target = args[0];
      const done = users.revoke(target);
      if (!done) return send(chatId, 'Nothing to revoke for <code>' + esc(target) + '</code> (or it is the owner).');
      await send(chatId, '🔒 Revoked <code>' + esc(target) + '</code>.');
      await send(target, '🔒 Your access to this bot was revoked.').catch(() => {});
      return;
    }

    case '/balance': {
      // Regular users see their own allowance, not the account's full balance.
      if (!owner) {
        const left = users.remaining(msg.from.id);
        if (left === null) return send(chatId, '💰 You have no spending limit.');
        if (users.isWalletMode(msg.from.id)) {
          return send(
            chatId,
            '💰 Your balance: <b>' + esc(users.eur(left)) + '</b>' +
              (left === 0 ? '\n\n<i>Ask an owner to add balance before ordering.</i>' : '')
          );
        }
        const myCredit = users.getCredit(msg.from.id);
        return send(
          chatId,
          '💰 <b>' + esc(users.eur(left)) + '</b> available\n' +
            esc(users.eur(users.dailyRoom(msg.from.id))) + ' left of today’s ' +
            esc(users.eur(users.getLimit(msg.from.id))) + ' limit' +
            (myCredit ? '\n' + esc(users.eur(myCredit)) + ' added balance' : '') +
            '\n<i>Daily part resets at 00:00 UTC.</i>'
        );
      }
      const { status, data } = await juicy('/account');
      if (status !== 200) return send(chatId, '❌ ' + esc(data.detail || data.title || 'Could not read the account.'));
      return send(chatId, '💰 Balance: <b>' + esc(money(data.balance)) + '</b>');
    }

    case '/stats': {
      const s = users.stats();
      const since = s.since ? fmtDate(s.since) : 'the start';

      // Non-owners see only their own numbers.
      if (!owner) {
        const mine = s.byUser[String(msg.from.id)] || { orders: 0, charged: 0, spentMinor: 0 };
        return send(
          chatId,
          '📊 <b>Your stats</b>\n\n' +
            'Numbers ordered: <b>' + mine.orders + '</b>\n' +
            'Codes received: <b>' + mine.charged + '</b>\n' +
            'Total spent: <b>' + esc(users.eur(mine.spentMinor)) + '</b>\n' +
            'Balance left: <b>' + esc(users.eur(users.remaining(msg.from.id))) + '</b>'
        );
      }

      const rate = s.orders ? Math.round((s.charged / s.orders) * 100) : 0;
      const lines = [
        '📊 <b>Stats</b> <i>since ' + esc(since) + '</i>',
        '',
        'Numbers ordered: <b>' + s.orders + '</b>',
        'Codes received: <b>' + s.charged + '</b> (' + rate + '% delivered)',
        'Total spent: <b>' + esc(users.eur(s.spentMinor)) + '</b>',
      ];

      const entries = Object.entries(s.byUser)
        .filter(([, v]) => v.orders || v.spentMinor)
        .sort((a, b) => b[1].spentMinor - a[1].spentMinor);

      if (entries.length) {
        lines.push('', '<b>By user</b>');
        for (const [id, v] of entries) {
          lines.push(
            '• <code>' + esc(id) + '</code> — ' + v.charged + '/' + v.orders + ' delivered · ' +
            '<b>' + esc(users.eur(v.spentMinor)) + '</b>'
          );
        }
      }

      const acct = await juicy('/account');
      if (acct.status === 200) {
        lines.push('', 'Account balance: <b>' + esc(money(acct.data.balance)) + '</b>');
      }

      // Orders placed in the web panel never pass through the bot, so say so
      // rather than presenting these as the account's complete history.
      lines.push('', '<i>Bot orders only — the web panel is not counted.</i>');
      return send(chatId, lines.join('\n'));
    }

    case '/usage': {
      const left = users.remaining(msg.from.id);
      if (left === null) return send(chatId, 'You have no spending limit.');
      const credit = users.getCredit(msg.from.id);
      if (users.isWalletMode(msg.from.id)) {
        return send(
          chatId,
          'Balance: <b>' + esc(users.eur(left)) + '</b>\n' +
            'Spent today: ' + esc(users.eur(users.todaySpend(msg.from.id))) + '\n\n' +
            '<i>Balance does not expire. Only an owner can top it up.</i>'
        );
      }
      return send(
        chatId,
        'Available now: <b>' + esc(users.eur(left)) + '</b>\n\n' +
          'Daily limit: ' + esc(users.eur(users.getLimit(msg.from.id))) +
          ' (spent ' + esc(users.eur(users.todaySpend(msg.from.id))) + ' today)\n' +
          (credit ? 'Added balance: ' + esc(users.eur(credit)) + '\n' : '') +
          '<i>The daily part resets at 00:00 UTC; added balance does not expire.</i>'
      );
    }

    case '/limit': {
      if (!owner) return send(chatId, 'Owner only.');
      if (args.length < 2) {
        return send(chatId, 'Usage: <code>/limit 123456789 5</code> (EUR per day)\n' +
          'Use <code>none</code> for unlimited, <code>0</code> to block ordering.');
      }
      const [target, rawAmount] = args;
      if (/^(none|unlimited)$/i.test(rawAmount)) {
        users.setLimit(target, null);
        await send(chatId, '✅ <code>' + esc(target) + '</code> is now unlimited.');
        await send(target, 'ℹ️ Your daily spending limit was removed.').catch(() => {});
        return;
      }
      const amount = Number(rawAmount);
      if (!Number.isFinite(amount) || amount < 0) return send(chatId, 'Amount must be a number of EUR, e.g. <code>2.50</code>.');
      const minor = Math.round(amount * 100);
      users.setLimit(target, minor);
      await send(chatId, '✅ <code>' + esc(target) + '</code> limit set to <b>' + esc(users.eur(minor)) + '</b>/day.');
      await send(target, 'ℹ️ Your daily spending limit is now <b>' + esc(users.eur(minor)) + '</b>.').catch(() => {});
      return;
    }

    case '/add': {
      if (!owner) return send(chatId, 'Owner only.');
      if (args.length < 2) {
        return send(chatId, 'Usage: <code>/add 123456789 5</code> — adds €5.00 of balance.\n' +
          'Use a negative amount to take it back: <code>/add 123456789 -2</code>');
      }
      const [target, rawAmount] = args;
      const amount = Number(rawAmount);
      if (!Number.isFinite(amount) || amount === 0) {
        return send(chatId, 'Amount must be a non-zero number of EUR, e.g. <code>5</code> or <code>2.50</code>.');
      }
      if (!users.isApproved(target)) {
        return send(chatId, '⚠️ <code>' + esc(target) + '</code> is not an approved user. Approve them first.');
      }

      const minor = Math.round(amount * 100);

      // Granting more than the account holds would only fail later, upstream,
      // as insufficient_balance — and by then the user has been told they have
      // money they cannot spend. Validate against the real balance instead.
      // Taking credit back is always allowed: it reduces the claim.
      if (minor > 0) {
        const acct = await juicy('/account');
        if (acct.status !== 200) {
          return send(
            chatId,
            '❌ Could not check the account balance, so the grant was not made.\n' +
              '<i>' + esc(acct.data.detail || acct.data.title || 'JuicySMS did not respond.') + '</i>'
          );
        }
        const balanceMinor = (acct.data.balance && acct.data.balance.amount_minor) || 0;
        const allocated = users.totalCredit();
        const headroom = balanceMinor - allocated;

        if (minor > headroom) {
          return send(
            chatId,
            '🚫 <b>Not enough unallocated balance.</b>\n\n' +
              'Account balance: <b>' + esc(users.eur(balanceMinor)) + '</b>\n' +
              'Already granted: ' + esc(users.eur(allocated)) + '\n' +
              'Free to grant: <b>' + esc(users.eur(Math.max(0, headroom))) + '</b>\n\n' +
              'You tried to add ' + esc(users.eur(minor)) + '.'
          );
        }
      }

      const total = users.addCredit(target, minor);
      const verb = minor > 0 ? 'Added' : 'Removed';

      await send(
        chatId,
        '💳 ' + verb + ' <b>' + esc(users.eur(Math.abs(minor))) + '</b> ' +
          (minor > 0 ? 'to' : 'from') + ' <code>' + esc(target) + '</code>\n' +
          'Their balance is now <b>' + esc(users.eur(total)) + '</b> ' +
          '(plus ' + esc(users.eur(users.dailyRoom(target))) + ' left of today’s limit).'
      );
      await send(
        target,
        minor > 0
          ? '💳 <b>' + esc(users.eur(minor)) + ' added to your balance.</b>\n\n' +
            'Balance: <b>' + esc(users.eur(total)) + '</b>\nUse <code>/usage</code> to check it any time.'
          : 'ℹ️ Your balance was adjusted to <b>' + esc(users.eur(total)) + '</b>.'
      ).catch(() => {});
      return;
    }

    case '/rm': {
      if (!owner) return send(chatId, 'Owner only.');
      if (args.length < 2) {
        return send(chatId, 'Usage: <code>/rm 123456789 5</code> — removes €5.00 of balance.\n' +
          'Use <code>/rm 123456789 all</code> to clear it entirely.');
      }
      const [target, rawAmount] = args;
      const before = users.getCredit(target);

      if (!before) {
        return send(chatId, '<code>' + esc(target) + '</code> has no balance to remove.');
      }

      let removed;
      let total;
      if (/^(all|max)$/i.test(rawAmount)) {
        removed = before;
        total = users.setCredit(target, 0);
      } else {
        const amount = Number(rawAmount);
        if (!Number.isFinite(amount) || amount <= 0) {
          return send(chatId, 'Amount must be a positive number of EUR, or <code>all</code>.');
        }
        // Never take more than they hold, so the reported figure is truthful.
        removed = Math.min(before, Math.round(amount * 100));
        total = users.addCredit(target, -removed);
      }

      await send(
        chatId,
        '💳 Removed <b>' + esc(users.eur(removed)) + '</b> from <code>' + esc(target) + '</code>\n' +
          'Balance: ' + esc(users.eur(before)) + ' → <b>' + esc(users.eur(total)) + '</b>'
      );
      await send(
        target,
        'ℹ️ <b>' + esc(users.eur(removed)) + '</b> was removed from your balance.\n\n' +
          'Balance: <b>' + esc(users.eur(total)) + '</b>'
      ).catch(() => {});
      return;
    }

    case '/limits': {
      if (!owner) return send(chatId, 'Owner only.');
      const { approved, ownerIds } = users.list();
      const lines = ['<b>Daily limits</b>', ''];
      for (const u of approved) {
        if (ownerIds.includes(String(u.id))) {
          lines.push('👑 ' + userLabel(u) + ' — unlimited');
          continue;
        }
        const credit = users.getCredit(u.id);
        if (users.isWalletMode(u.id)) {
          lines.push(
            '• ' + userLabel(u) + '\n    balance <b>' + esc(users.eur(credit)) + '</b>' +
            ' · spent today ' + esc(users.eur(users.todaySpend(u.id)))
          );
        } else {
          lines.push(
            '• ' + userLabel(u) + '\n    ' +
            esc(users.eur(users.todaySpend(u.id))) + ' spent of ' + esc(users.eur(users.getLimit(u.id))) +
            (credit ? ' · +' + esc(users.eur(credit)) + ' balance' : '') +
            ' · <b>' + esc(users.eur(users.remaining(u.id))) + '</b> available'
          );
        }
      }
      lines.push(
        '',
        users.DEFAULT_LIMIT_MINOR === 0
          ? '<i>New users start with no balance — fund them with /add.</i>'
          : '<i>Default for new users: ' + esc(users.eur(users.DEFAULT_LIMIT_MINOR)) + '/day</i>'
      );

      // Granted credit is a claim on the shared balance, so show what is left.
      const acct = await juicy('/account');
      if (acct.status === 200) {
        const balanceMinor = (acct.data.balance && acct.data.balance.amount_minor) || 0;
        const allocated = users.totalCredit();
        lines.push(
          '',
          '<b>Balance allocation</b>',
          'Account: ' + esc(users.eur(balanceMinor)),
          'Granted: ' + esc(users.eur(allocated)),
          'Free to grant: <b>' + esc(users.eur(Math.max(0, balanceMinor - allocated))) + '</b>'
        );
        if (allocated > balanceMinor) {
          lines.push('⚠️ <i>Granted more than the account holds — orders will fail upstream.</i>');
        }
      }
      return send(chatId, lines.join('\n'));
    }

    case '/price': {
      if (!args.length) return send(chatId, 'Usage: <code>/price whatsapp [country]</code>');

      // Prices are per country; without one the API returns price: null.
      const { term, country } = splitTermAndCountry(args);
      const { status, data } = await juicy('/services', { query: { search: term, country } });
      if (status !== 200) return send(chatId, '❌ ' + esc(data.detail || 'Lookup failed.'));

      const list = (data.data || []).slice(0, 15);
      if (!list.length) {
        return send(chatId, 'No service matches “' + esc(term) + '” in ' + esc(country) + '.');
      }
      return send(
        chatId,
        '<b>' + esc(term || 'Services') + ' · ' + esc(country) + '</b>\n' +
          list.map((s) => '• ' + esc(s.name) + ' — <b>' + esc(money(s)) + '</b>').join('\n') +
          (data.count && data.count > list.length
            ? '\n\n<i>' + esc(data.count - list.length) + ' more — narrow the search.</i>'
            : '') +
          '\n\n<i>Other countries: uk, usa, nl, de, pl, ph</i>'
      );
    }

    case '/order': {
      if (!args.length) return send(chatId, 'Usage: <code>/order whatsapp uk</code>');
      if (args.length === 1 && COUNTRIES[args[0].toLowerCase()]) {
        return send(chatId, 'That looks like a country. Usage: <code>/order whatsapp uk</code>');
      }

      const { term, country } = splitTermAndCountry(args);
      const svc = await findService(term, country);
      if (!svc) return send(chatId, 'No service matches “' + esc(term) + '”. Try <code>/price ' + esc(term) + '</code>.');

      await send(chatId, '⏳ Ordering <b>' + esc(svc.name) + '</b> (' + esc(country) + ') for ' + esc(money(svc)) + '…');
      return placeOrder(chatId, msg.from.id, svc, country);
    }

    case '/status': {
      const order = await openOrder();
      if (!order) return send(chatId, 'No open order. Use <code>/order whatsapp uk</code>.');
      const { data: msgs } = await juicy('/orders/' + order.id + '/messages');
      const messages = (msgs && msgs.data) || [];
      const code = messages.length ? codeOf(messages[0]) : null;
      return send(
        chatId,
        '📱 <b>' + esc(order.phone_number) + '</b>\n' +
          esc(order.service ? order.service.name : '') + ' · ' + esc(order.country) +
          '\n' +
          'Status: <b>' + esc(order.status) + '</b>\n' +
          (code ? '\nCode: <code>' + esc(code) + '</code>' : '\n<i>No SMS yet.</i>')
      );
    }

    case '/skip': {
      const order = await openOrder();
      if (!order) return send(chatId, 'No open order to skip.');
      return skipAndReorder(chatId, msg.from.id, order.id);
    }

    case '/cancel': {
      const order = await openOrder();
      if (!order) return send(chatId, 'No open order to cancel.');
      const action = 'cancel';
      const { status, data } = await juicy('/orders/' + order.id + '/' + action, { method: 'POST' });
      if (status !== 200 && status !== 201) {
        return send(chatId, '❌ ' + esc(data.detail || 'Could not ' + action + '.'));
      }
      const w = watchers.get(String(order.id));
      unwatch(order.id);
      releaseReservation(w); // canceled before an SMS => nothing was charged
      return send(chatId, (action === 'skip' ? '⛔ Skipped' : '🚫 Canceled') + ' that number.');
    }

    case '/reuse': {
      const { status, data } = await juicy('/orders', { query: { status: 'completed', limit: 1 } });
      const last = status === 200 ? (data.data || [])[0] : null;
      if (!last) return send(chatId, 'No completed order to reuse.');
      return doReuse(chatId, last.id, msg.from.id);
    }

    case '/history': {
      const { status, data } = await juicy('/orders', { query: { limit: 8 } });
      if (status !== 200) return send(chatId, '❌ Could not load history.');
      const list = data.data || [];
      if (!list.length) return send(chatId, 'No orders yet.');
      return send(
        chatId,
        '<b>Recent orders</b>\n' +
          list
            .map((o) =>
              '• <code>' + esc(o.phone_number || '—') + '</code> · ' +
              esc(o.service ? o.service.name : '') + ' · ' + esc(o.status)
            )
            .join('\n')
      );
    }

    default:
      return send(chatId, 'Unknown command. Try <code>/help</code>.');
  }
}

async function doReuse(chatId, orderId, userId) {
  // Reuse bills half price. The reuse response carries no price, so look the
  // service up to know what to reserve.
  let halfMinor = 0;
  const prev = await juicy('/orders/' + orderId);
  const svcName = prev.status === 200 && prev.data.service ? prev.data.service.name : null;
  if (svcName) {
    const svc = await findService(svcName);
    if (svc && svc.price && svc.price.amount_minor) halfMinor = Math.ceil(svc.price.amount_minor / 2);
  }

  const left = users.remaining(userId);
  if (left !== null && halfMinor > left) {
    return send(
      chatId,
      '🚫 <b>Daily limit reached.</b>\n\nReuse costs about ' + esc(users.eur(halfMinor)) +
        ', but you have ' + esc(users.eur(left)) + ' left today.'
    );
  }

  const { status, data } = await juicy('/orders/' + orderId + '/reuse', { method: 'POST' });
  if (status !== 200 && status !== 201) {
    return send(chatId, '❌ ' + esc(data.detail || data.title || 'Reuse failed.'));
  }
  const reuseSplit = users.addSpend(userId, halfMinor);
  watchOrder(data.id, chatId, (data.service && data.service.name) || 'Reused', userId, halfMinor, reuseSplit);
  return send(
    chatId,
    '♻️ Reordered <b>' + esc(data.phone_number) + '</b>\n' +
      '<i>Waiting for the SMS…</i>'
  );
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const [action, orderId] = String(cb.data || '').split(':');

  await tg('answerCallbackQuery', { callback_query_id: cb.id });

  // Approval decisions are the owner's alone.
  if (action === 'approve' || action === 'deny') {
    if (!users.isOwner(cb.from.id)) return send(chatId, 'Owner only.');
    if (action === 'approve') {
      const u = users.approve(orderId);
      const wallet = users.isWalletMode(orderId);
      await send(
        chatId,
        '✅ Approved ' + userLabel(u) +
          (wallet ? '\n\n<i>They have no balance yet — use <code>/add ' + esc(orderId) + ' 5</code> to fund them.</i>' : '')
      );
      await send(
        orderId,
        '✅ <b>Access granted.</b>\n\n' +
          (wallet
            ? 'Your balance is <b>' + esc(users.eur(users.remaining(orderId))) +
              '</b> — an owner needs to add balance before you can order.'
            : 'Daily limit: <b>' + esc(users.eur(users.getLimit(orderId))) + '</b>') +
          '\n\nSend <code>/help</code> to see what I can do.'
      );
    } else {
      users.deny(orderId);
      await send(chatId, '⛔ Denied <code>' + esc(orderId) + '</code>');
      await send(orderId, '⛔ Your access request was declined.');
    }
    return;
  }

  if (action === 'reuse') return doReuse(chatId, orderId, cb.from.id);

  if (action === 'bcast') {
    if (!users.isOwner(cb.from.id)) return send(chatId, 'Owner only.');
    if (orderId === 'cancel') {
      pendingBroadcasts.delete(String(cb.from.id));
      return send(chatId, '✖️ Broadcast cancelled — nothing was sent.');
    }
    return sendBroadcast(chatId, cb.from.id);
  }

  if (action === 'skip') return skipAndReorder(chatId, cb.from.id, orderId);

  if (action === 'cancel') {
    const { status, data } = await juicy('/orders/' + orderId + '/cancel', { method: 'POST' });
    if (status !== 200 && status !== 201) {
      return send(chatId, '❌ ' + esc(data.detail || 'Could not cancel.'));
    }
    const w = watchers.get(String(orderId));
    unwatch(orderId);
    releaseReservation(w);
    return send(chatId, '🚫 Canceled that number.');
  }
}

// ---------- Webhook entry point ----------

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  const cb = update.callback_query;
  const from = (msg && msg.from) || (cb && cb.from);
  if (!from) return;

  const chatId = (msg && msg.chat.id) || (cb && cb.message.chat.id);

  // Bootstrap: with no owner recorded yet, whoever speaks first claims the bot.
  // Pin it afterwards with TELEGRAM_OWNER_ID so it can never be re-claimed.
  if (!users.ownerId()) {
    users.claimOwner(from);
    await send(
      chatId,
      '👑 <b>You are now the owner of this bot.</b>\n\n' +
        'Your Telegram id is <code>' + esc(from.id) + '</code> — set it as ' +
        '<code>TELEGRAM_OWNER_ID</code> so ownership is permanent.\n\n' +
        'Anyone else who starts this bot will need your approval. Send <code>/help</code>.'
    );
    return;
  }

  if (users.isApproved(from.id)) {
    try {
      if (msg && msg.text) return await handleCommand(msg);
      if (cb) return await handleCallback(cb);
    } catch (err) {
      console.error('Telegram handler error:', err);
    }
    return;
  }

  if (users.isDenied(from.id)) {
    return; // stay silent rather than give a denied user a reply loop
  }

  if (users.isPending(from.id)) {
    return send(chatId, '⏳ Your access request is still waiting for approval.');
  }

  // New face: record the request and put it in front of the owner.
  users.requestAccess(from);
  await send(
    chatId,
    '👋 Hi ' + esc(from.first_name || '') + '!\n\n' +
      'This bot is private. I have sent your request to the owner — ' +
      'you will get a message here once they decide.\n\n' +
      'Your Telegram id: <code>' + esc(from.id) + '</code>'
  );
  await notifyOwnerOfRequest(from);
  console.log('Access requested by', from.id, from.username || '');
}

function isConfigured() {
  return Boolean(BOT_TOKEN);
}

// Async now: persisted state must be in memory before the first update is
// handled, or an approved user could be treated as a stranger.
async function start() {
  if (!isConfigured()) return false;
  await users.init();
  await loadWatchers();
  setInterval(() => {
    tick().catch((err) => console.error('watch tick failed:', err.message));
  }, POLL_MS);
  return true;
}

module.exports = { handleUpdate, start, isConfigured, users, splitTermAndCountry, broadcastRecipients, formatBroadcast };
