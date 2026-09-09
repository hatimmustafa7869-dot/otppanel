/* OTP Panel — talks only to this server's /api/* proxy, never to JuicySMS directly. */

const COUNTRIES = [
  { code: 'UK', flag: '🇬🇧', name: 'United Kingdom', dial: '+44' },
  { code: 'USA', flag: '🇺🇸', name: 'United States', dial: '+1' },
  { code: 'NL', flag: '🇳🇱', name: 'Netherlands', dial: '+31' },
  { code: 'DE', flag: '🇩🇪', name: 'Germany', dial: '+49' },
  { code: 'PL', flag: '🇵🇱', name: 'Poland', dial: '+48' },
  { code: 'PH', flag: '🇵🇭', name: 'Philippines', dial: '+63' },
];

const POLL_MS = 3000;
const $ = (sel) => document.querySelector(sel);

const state = {
  services: [],        // catalog for the currently selected order country
  activeOrder: null,   // the order we are polling
  pollTimer: null,
  tickTimer: null,
  ordersCursor: null,
  rentalPackages: [],
  fx: { rate: null, as_of: null, source: null },
};

// EUR -> USD for display only; prices and charges stay in EUR.
async function loadFx() {
  try {
    const fx = await api('/fx');
    state.fx = fx;
  } catch {
    state.fx = { rate: null, as_of: null, source: null };
  }
}

// ---------------- helpers ----------------

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data.detail || data.title || ('HTTP ' + res.status));
    err.code = data.code;
    err.title = data.title || 'Request failed';
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function toast(title, detail, kind) {
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.innerHTML = '<b></b><div class="t-detail"></div>';
  el.querySelector('b').textContent = title;
  el.querySelector('.t-detail').textContent = detail || '';
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 320);
  }, kind === 'err' ? 7000 : 4200);
}

function errToast(err) {
  toast(err.title || 'Error', err.message, 'err');
  console.error(err);
}

// Accepts either a price object ({amount, currency}) or any entity that carries
// one. The live API is inconsistent: services use `price`, rental packages use
// `your_price`/`list_price`, and orders carry no price at all.
function priceObj(value) {
  if (!value) return null;
  const price = value.amount ? value : (value.price || value.your_price || value.list_price);
  return price && price.amount ? price : null;
}

function money(value) {
  const price = priceObj(value);
  return price ? '€' + price.amount : '—';
}

function hasPrice(value) {
  return priceObj(value) !== null;
}

// USD is display-only — JuicySMS charges in EUR — so it is always marked
// approximate and simply omitted when no rate could be fetched.
function usd(value) {
  const price = priceObj(value);
  if (!price || !state.fx.rate) return '';
  const amount = Number(price.amount);
  if (!isFinite(amount)) return '';
  return '$' + (amount * state.fx.rate).toFixed(2);
}

// "€1.50 ≈ $1.74"
function moneyBoth(value) {
  const eur = money(value);
  if (eur === '—') return eur;
  const dollars = usd(value);
  return dollars ? eur + ' ≈ ' + dollars : eur;
}

// JuicySMS's own `code` field is unreliable. Carriers put an Android SMS
// Retriever app hash (11 chars) on its own line, the API strips newlines, and
// their extractor then swallows the hash's leading digits — a real WhatsApp
// message of "…code: 760-974" + "4sgLq1p5sV6" was reported as code "7609744".
// So parse the text ourselves and keep their value only as a last resort.
function extractCode(text, fallback) {
  if (!text) return fallback || null;
  const clean = String(text).replace(/^<#>\s*/, '');

  // 1. Hyphenated 3-3 (WhatsApp, Google). Deliberately does NOT require a
  //    boundary after, so a glued app hash cannot bleed into the digits.
  const hyphen = clean.match(/(\d{3})-(\d{3})/);
  if (hyphen) return hyphen[1] + hyphen[2];

  // 2. Digits immediately following a "code"/"otp"/"pin" label.
  const labelled = clean.match(/(?:code|otp|pin|password)\D{0,15}?(\d{4,8})/i);
  if (labelled) return labelled[1];

  // 3. Any standalone run of 4-8 digits.
  const standalone = clean.match(/(?<![\dA-Za-z])(\d{4,8})(?![\dA-Za-z])/);
  if (standalone) return standalone[1];

  return fallback || null;
}

// The code for a message, preferring our own parse over the API's.
function codeOf(message) {
  return message ? extractCode(message.text, message.code) : null;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function countdown(toIso) {
  const ms = new Date(toIso).getTime() - Date.now();
  if (ms <= 0) return '0:00';
  const total = Math.floor(ms / 1000);
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

function flagFor(code) {
  const c = COUNTRIES.find((x) => x.code === code || x.name === code);
  return c ? c.flag : '🌐';
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied', (label || '') + ' ' + text, 'ok');
  } catch {
    toast('Copy failed', 'Select and copy manually: ' + text, 'err');
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------------- tabs ----------------

$('#tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('active', v.id === 'view-' + tab.dataset.view);
  });
  if (tab.dataset.view === 'orders') loadOrders();
  if (tab.dataset.view === 'rentals') loadRentals();
  if (tab.dataset.view === 'services') loadCatalog();
});

// ---------------- account ----------------

async function loadAccount() {
  const chip = $('#balanceChip');
  try {
    const acc = await api('/account');
    $('#balanceValue').textContent = money(acc.balance);
    const dollars = usd(acc.balance);
    const usdNode = $('#balanceUsd'); // absent if a stale index.html is cached
    if (usdNode) usdNode.textContent = dollars ? '≈ ' + dollars : '';
    chip.classList.remove('err');
    chip.title =
      (acc.parallel_orders_allowed ? 'Parallel orders allowed' : 'One open order at a time') +
      (state.fx.rate ? ' · USD at €1 = $' + state.fx.rate.toFixed(4) + ' (' + (state.fx.as_of || '') + ')' : '');
  } catch (err) {
    $('#balanceValue').textContent = 'error';
    chip.classList.add('err');
    chip.title = err.message;
    errToast(err);
  }
}

$('#refreshBtn').addEventListener('click', () => {
  loadAccount();
  if (state.activeOrder) pollActiveOrder();
});

// ---------------- services ----------------

function fillCountrySelects() {
  const html = COUNTRIES.map(
    (c) => '<option value="' + c.code + '">' + c.flag + ' ' + c.name + ' (' + c.dial + ')</option>'
  ).join('');
  $('#orderCountry').innerHTML = html;
  $('#catalogCountry').innerHTML = html;
}

async function loadServices(country) {
  const select = $('#orderService');
  select.innerHTML = '<option value="">Loading services…</option>';
  try {
    const res = await api('/services?country=' + encodeURIComponent(country));
    state.services = res.data || [];
    renderServiceOptions();
  } catch (err) {
    select.innerHTML = '<option value="">Could not load services</option>';
    errToast(err);
  }
}

function renderServiceOptions() {
  const term = $('#serviceSearch').value.trim().toLowerCase();
  const list = term
    ? state.services.filter((s) => s.name.toLowerCase().includes(term))
    : state.services;
  const select = $('#orderService');
  const previous = select.value;

  if (!list.length) {
    select.innerHTML = '<option value="">No matching services</option>';
    updatePricePreview();
    return;
  }
  select.innerHTML = list
    .map((s) => '<option value="' + s.id + '">' + s.name + ' — ' + moneyBoth(s) + '</option>')
    .join('');
  if (previous && list.some((s) => String(s.id) === previous)) select.value = previous;
  updatePricePreview();
}

function updatePricePreview() {
  const id = $('#orderService').value;
  const svc = state.services.find((s) => String(s.id) === id);
  if (!svc) {
    $('#pricePreview').innerHTML = 'Select a service to see the price';
    return;
  }
  const dollars = usd(svc);
  $('#pricePreview').innerHTML =
    'Price: <b>' + money(svc) + '</b>' +
    (dollars ? ' <span class="usd">≈ ' + dollars + '</span>' : '') +
    ' — charged only on delivery';
}

$('#orderCountry').addEventListener('change', (e) => loadServices(e.target.value));
$('#serviceSearch').addEventListener('input', renderServiceOptions);
$('#orderService').addEventListener('change', updatePricePreview);

// ---------------- ordering ----------------

$('#orderBtn').addEventListener('click', async () => {
  const btn = $('#orderBtn');
  const country = $('#orderCountry').value;
  const serviceId = $('#orderService').value;
  const maxPrice = $('#maxPrice').value;

  if (!serviceId) return toast('Pick a service', 'Choose which service the number is for.', 'err');

  btn.disabled = true;
  btn.textContent = 'Ordering…';
  try {
    const order = await api('/orders', {
      method: 'POST',
      body: { country, service_id: serviceId, max_price: maxPrice || undefined },
    });
    setActiveOrder(order);
    toast('Number ordered', order.phone_number, 'ok');
    loadAccount();
  } catch (err) {
    if (err.code === 'out_of_stock') {
      toast('Out of stock', 'No numbers available for that service right now — try another country.', 'err');
    } else if (err.code === 'concurrent_order_limit') {
      toast('Order already open', 'Finish or cancel your open order first.', 'err');
      resumeOpenOrder();
    } else if (err.code === 'price_above_maximum') {
      const svc = state.services.find((s) => String(s.id) === String(serviceId));
      toast(
        'Above your max price',
        'This service now costs ' + moneyBoth(svc) + '. Raise or clear the max price field.',
        'err'
      );
    } else if (err.code === 'insufficient_balance') {
      const bal = err.data.balance ? money(err.data.balance) : '';
      toast('Insufficient balance', 'Top up your account. Balance: ' + bal, 'err');
    } else {
      errToast(err);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Order number';
  }
});

function setActiveOrder(order) {
  state.activeOrder = order;
  localStorage.setItem('activeOrderId', order.id);
  renderActiveOrder();
  startPolling();
}

function clearActiveOrder() {
  state.activeOrder = null;
  localStorage.removeItem('activeOrderId');
  stopPolling();
  renderActiveOrder();
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(pollActiveOrder, POLL_MS);
  state.tickTimer = setInterval(tickCountdown, 1000);
}

function stopPolling() {
  clearInterval(state.pollTimer);
  clearInterval(state.tickTimer);
  state.pollTimer = null;
  state.tickTimer = null;
}

function tickCountdown() {
  const node = $('#activeCountdown');
  if (node && state.activeOrder) node.textContent = countdown(state.activeOrder.expires_at);
}

async function pollActiveOrder() {
  if (!state.activeOrder) return;
  try {
    const res = await api('/orders/' + state.activeOrder.id + '/messages');
    const messages = res.data || [];
    state.activeOrder.status = res.order_status || state.activeOrder.status;
    state.activeOrder.messages = messages;
    if (messages.length) state.activeOrder.code = codeOf(messages[0]) || state.activeOrder.code;
    if (state.activeOrder.status !== 'pending') {
      stopPolling();
      if (messages.length) {
        toast('Code received', state.activeOrder.code || messages[0].text, 'ok');
        loadAccount();
      }
    }
    renderActiveOrder();
  } catch (err) {
    if (err.status === 404) clearActiveOrder();
    else console.warn('poll failed:', err.message);
  }
}

function renderActiveOrder() {
  const box = $('#activeOrder');
  const order = state.activeOrder;
  box.innerHTML = '';

  if (!order) {
    box.className = 'empty';
    box.textContent = 'No active order. Order a number to start.';
    return;
  }
  box.className = '';

  const head = el('div', 'row between wrap');
  const title = el('div', 'item-title');
  title.append(
    el('span', null, flagFor(order.country) + ' ' + (order.service ? order.service.name : 'Order')),
    el('span', 'badge ' + order.status, order.status)
  );
  const meta = '#' + order.id + (hasPrice(order) ? ' · ' + moneyBoth(order) : '');
  head.append(title, el('div', 'muted small', meta));
  box.append(head);

  // phone number + copy
  const phoneBox = el('div', 'phone-box');
  phoneBox.append(el('div', 'phone-number mono', order.phone_number || '—'));
  const copyPhone = el('button', 'btn small', 'Copy number');
  copyPhone.onclick = () => copy(order.phone_number, 'Number');
  phoneBox.append(copyPhone);
  box.append(phoneBox);

  const messages = order.messages || [];

  if (order.code || messages.length) {
    const codeBox = el('div', 'code-box');
    codeBox.append(el('div', 'code-label', 'Verification code'));
    codeBox.append(el('div', 'code-value', order.code || '—'));
    if (order.code) {
      const copyCode = el('button', 'btn small', 'Copy code');
      copyCode.style.marginTop = '10px';
      copyCode.onclick = () => copy(order.code, 'Code');
      codeBox.append(copyCode);
    }
    box.append(codeBox);

    messages.forEach((m) => {
      const msg = el('div', 'sms-msg');
      const meta = el('div', 'sms-meta');
      meta.append(el('span', null, m.sender || 'Unknown sender'), el('span', null, fmtTime(m.received_at)));
      msg.append(meta, el('div', 'sms-text', m.text || ''));
      box.append(msg);
    });
  } else if (order.status === 'pending') {
    const wait = el('div', 'waiting');
    wait.append(el('div', 'spinner'));
    const info = el('div');
    info.append(el('div', null, 'Waiting for SMS…'));
    const sub = el('div', 'muted small');
    sub.append(document.createTextNode('Expires in '));
    const cd = el('span', 'countdown', countdown(order.expires_at));
    cd.id = 'activeCountdown';
    sub.append(cd);
    info.append(sub);
    wait.append(info);
    box.append(wait);
  } else {
    box.append(el('div', 'empty', 'No message arrived — order ' + order.status + '.'));
  }

  // actions
  const actions = el('div', 'row end gap');
  actions.style.marginTop = '14px';

  if (order.status === 'pending') {
    const cancel = el('button', 'btn small danger', 'Cancel');
    cancel.onclick = () => orderAction(order.id, 'cancel');
    const skip = el('button', 'btn small', 'Skip number');
    skip.title = 'Cancel and blacklist this number';
    skip.onclick = () => orderAction(order.id, 'skip');
    actions.append(skip, cancel);
  } else {
    if (messages.length) {
      const reuse = el('button', 'btn small', 'Reuse number (half price)');
      reuse.onclick = () => orderAction(order.id, 'reuse');
      actions.append(reuse);
    }
    const done = el('button', 'btn small ghost', 'Clear');
    done.onclick = clearActiveOrder;
    actions.append(done);
  }
  box.append(actions);
}

async function orderAction(id, action) {
  try {
    const result = await api('/orders/' + id + '/' + action, { method: 'POST' });
    if (action === 'reuse' && result && result.id) {
      setActiveOrder(result);
      toast('Number reused', result.phone_number, 'ok');
    } else {
      toast(action === 'skip' ? 'Number skipped' : 'Order canceled', 'Order #' + id, 'ok');
      if (state.activeOrder && String(state.activeOrder.id) === String(id)) clearActiveOrder();
    }
    loadAccount();
    if ($('#view-orders').classList.contains('active')) loadOrders();
  } catch (err) {
    errToast(err);
  }
}

// Restores an order that is still open server-side (page refresh, or a stray
// order blocking a new one because of the one-open-order limit).
async function resumeOpenOrder() {
  const saved = localStorage.getItem('activeOrderId');
  try {
    if (saved) {
      const order = await api('/orders/' + saved);
      if (order.status === 'pending') { setActiveOrder(order); return; }
    }
    const res = await api('/orders?status=pending&limit=1');
    if (res.data && res.data.length) setActiveOrder(res.data[0]);
    else localStorage.removeItem('activeOrderId');
  } catch {
    localStorage.removeItem('activeOrderId');
  }
}

// ---------------- order history ----------------

async function loadOrders(cursor) {
  const list = $('#ordersList');
  const pager = $('#ordersPager');
  if (!cursor) list.innerHTML = '<div class="empty">Loading…</div>';
  pager.innerHTML = '';

  try {
    const params = new URLSearchParams({ limit: '25' });
    const status = $('#orderStatusFilter').value;
    if (status) params.set('status', status);
    if (cursor) params.set('cursor', cursor);

    const res = await api('/orders?' + params.toString());
    const orders = res.data || [];
    if (!cursor) list.innerHTML = '';
    if (!orders.length && !cursor) {
      list.innerHTML = '<div class="empty">No orders yet.</div>';
      return;
    }
    orders.forEach((o) => list.append(orderRow(o)));

    if (res.pagination && res.pagination.has_more) {
      const more = el('button', 'btn ghost small', 'Load more');
      more.onclick = () => { more.remove(); loadOrders(res.pagination.next_cursor); };
      pager.append(more);
    }
  } catch (err) {
    list.innerHTML = '<div class="empty">Could not load orders.</div>';
    errToast(err);
  }
}

function orderRow(o) {
  const row = el('div', 'item');

  const main = el('div', 'item-main');
  const title = el('div', 'item-title');
  title.append(
    el('span', null, flagFor(o.country) + ' ' + (o.service ? o.service.name : 'Service')),
    el('span', 'badge ' + o.status, o.status)
  );
  if (o.code) title.append(el('span', 'code-pill', o.code));
  main.append(title);
  // The list endpoint omits price/charged, so only render what actually came back.
  const parts = [o.phone_number || '—', '#' + o.id, fmtTime(o.created_at)];
  if (hasPrice(o)) parts.push(moneyBoth(o));
  if (o.reused_from_order_id) parts.push('reused from #' + o.reused_from_order_id);
  main.append(el('div', 'item-sub mono', parts.join(' · ')));
  row.append(main);

  const actions = el('div', 'item-actions');
  if (o.phone_number) {
    const cp = el('button', 'btn small ghost', 'Copy');
    cp.onclick = () => copy(o.phone_number, 'Number');
    actions.append(cp);
  }
  if (o.status === 'pending') {
    const resume = el('button', 'btn small', 'Track');
    resume.onclick = () => { setActiveOrder(o); document.querySelector('.tab[data-view="order"]').click(); };
    const cancel = el('button', 'btn small danger', 'Cancel');
    cancel.onclick = () => orderAction(o.id, 'cancel');
    actions.append(resume, cancel);
  } else {
    const msgs = el('button', 'btn small ghost', 'Messages');
    msgs.onclick = () => toggleOrderMessages(o.id, row, msgs);
    actions.append(msgs);
    // Reuse needs the order to have received a message — completed is that signal
    // (the list endpoint exposes no `charged` flag).
    if (o.status === 'completed') {
      const reuse = el('button', 'btn small', 'Reuse');
      reuse.title = 'Order this same number again at half price';
      reuse.onclick = () => orderAction(o.id, 'reuse');
      actions.append(reuse);
    }
  }
  row.append(actions);
  return row;
}

async function toggleOrderMessages(id, row, btn) {
  const existing = row.querySelector('.item-extra');
  if (existing) { existing.remove(); btn.textContent = 'Messages'; return; }
  btn.textContent = 'Hide';
  const holder = el('div', 'item-extra');
  holder.append(el('div', 'muted small', 'Loading…'));
  row.append(holder);
  try {
    const res = await api('/orders/' + id + '/messages');
    holder.innerHTML = '';
    const messages = res.data || [];
    if (!messages.length) { holder.append(el('div', 'muted small', 'No messages on this order.')); return; }
    messages.forEach((m) => holder.append(messageBlock(m)));
  } catch (err) {
    holder.innerHTML = '';
    holder.append(el('div', 'muted small', 'Could not load messages.'));
    errToast(err);
  }
}

function messageBlock(m) {
  const msg = el('div', 'sms-msg');
  const meta = el('div', 'sms-meta');
  meta.append(el('span', null, m.sender || 'Unknown'), el('span', null, fmtTime(m.received_at)));
  msg.append(meta);
  const text = el('div', 'sms-text');
  text.textContent = m.text || '';
  msg.append(text);
  const code = codeOf(m);
  if (code) {
    const cp = el('button', 'btn small ghost', 'Copy code ' + code);
    cp.style.marginTop = '8px';
    cp.onclick = () => copy(code, 'Code');
    msg.append(cp);
  }
  return msg;
}

$('#ordersRefresh').addEventListener('click', () => loadOrders());
$('#orderStatusFilter').addEventListener('change', () => loadOrders());

// ---------------- rentals ----------------

async function loadRentalPackages() {
  const select = $('#rentalPackage');
  try {
    const res = await api('/rental-packages');
    state.rentalPackages = res.data || [];
    if (!state.rentalPackages.length) {
      select.innerHTML = '<option value="">No packages available</option>';
      return;
    }
    select.innerHTML = state.rentalPackages
      .map((p) => '<option value="' + p.key + '">' + p.name + ' — ' + p.days + ' days — ' + moneyBoth(p) + '</option>')
      .join('');
  } catch (err) {
    select.innerHTML = '<option value="">Could not load packages</option>';
    errToast(err);
  }
}

$('#rentalBtn').addEventListener('click', async () => {
  const btn = $('#rentalBtn');
  const pkg = $('#rentalPackage').value;
  if (!pkg) return toast('Pick a package', 'Choose a rental duration first.', 'err');

  btn.disabled = true;
  btn.textContent = 'Renting…';
  try {
    const rental = await api('/rentals', {
      method: 'POST',
      body: {
        country: $('#rentalCountry').value,
        package: pkg,
        auto_renew: $('#rentalAutoRenew').checked,
      },
    });
    toast('Number rented', rental.phone_number, 'ok');
    loadAccount();
    loadRentals();
  } catch (err) {
    errToast(err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Rent number';
  }
});

async function loadRentals() {
  const list = $('#rentalsList');
  list.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const res = await api('/rentals?limit=50');
    const rentals = res.data || [];
    list.innerHTML = '';
    if (!rentals.length) { list.innerHTML = '<div class="empty">No rentals yet.</div>'; return; }
    rentals.forEach((r) => list.append(rentalRow(r)));
  } catch (err) {
    list.innerHTML = '<div class="empty">Could not load rentals.</div>';
    errToast(err);
  }
}

function rentalRow(r) {
  const row = el('div', 'item');

  const main = el('div', 'item-main');
  const title = el('div', 'item-title');
  title.append(
    el('span', 'mono', flagFor(r.country) + ' ' + (r.phone_number || '—')),
    el('span', 'badge ' + r.status, r.status)
  );
  main.append(title);
  const rParts = ['#' + r.id, r.package || '', 'expires ' + fmtTime(r.expires_at)];
  if (hasPrice(r)) rParts.push(moneyBoth(r));
  rParts.push(r.auto_renew ? 'auto-renew on' : 'auto-renew off');
  main.append(el('div', 'item-sub', rParts.filter(Boolean).join(' · ')));
  row.append(main);

  const actions = el('div', 'item-actions');

  const msgs = el('button', 'btn small ghost', 'Messages');
  msgs.onclick = () => toggleRentalMessages(r.id, row, msgs);
  actions.append(msgs);

  const renew = el('button', 'btn small', r.auto_renew ? 'Turn off renew' : 'Turn on renew');
  renew.onclick = async () => {
    try {
      await api('/rentals/' + r.id, { method: 'PATCH', body: { auto_renew: !r.auto_renew } });
      toast('Rental updated', 'Auto-renew ' + (r.auto_renew ? 'disabled' : 'enabled'), 'ok');
      loadRentals();
    } catch (err) { errToast(err); }
  };
  actions.append(renew);

  if (state.rentalPackages.length) {
    const extend = el('button', 'btn small', 'Extend');
    extend.onclick = async () => {
      const pkg = $('#rentalPackage').value;
      if (!pkg) return toast('Pick a package', 'Choose one in the rent form first.', 'err');
      try {
        await api('/rentals/' + r.id + '/extend', { method: 'POST', body: { package: pkg } });
        toast('Rental extended', 'Added the ' + pkg + ' package', 'ok');
        loadAccount();
        loadRentals();
      } catch (err) { errToast(err); }
    };
    actions.append(extend);
  }

  const cp = el('button', 'btn small ghost', 'Copy');
  cp.onclick = () => copy(r.phone_number, 'Number');
  actions.append(cp);

  row.append(actions);
  return row;
}

async function toggleRentalMessages(id, row, btn) {
  const existing = row.querySelector('.item-extra');
  if (existing) { existing.remove(); btn.textContent = 'Messages'; return; }
  btn.textContent = 'Hide';
  const holder = el('div', 'item-extra');
  holder.append(el('div', 'muted small', 'Loading…'));
  row.append(holder);
  try {
    const res = await api('/rentals/' + id + '/messages');
    holder.innerHTML = '';
    const messages = res.data || [];
    if (!messages.length) { holder.append(el('div', 'muted small', 'No messages yet.')); return; }
    messages.forEach((m) => holder.append(messageBlock(m)));
  } catch (err) {
    holder.innerHTML = '';
    holder.append(el('div', 'muted small', 'Could not load messages.'));
    errToast(err);
  }
}

$('#rentalsRefresh').addEventListener('click', loadRentals);

// ---------------- catalog ----------------

let catalogTimer = null;

async function loadCatalog() {
  const list = $('#catalogList');
  list.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const params = new URLSearchParams({ country: $('#catalogCountry').value });
    const search = $('#catalogSearch').value.trim();
    if (search) params.set('search', search);

    const res = await api('/services?' + params.toString());
    const services = res.data || [];
    list.innerHTML = '';
    if (!services.length) { list.innerHTML = '<div class="empty">No services match that search.</div>'; return; }

    services.forEach((s) => {
      const card = el('div', 'svc');
      card.title = 'Order ' + s.name;
      const priceCol = el('div', 'svc-price');
      priceCol.append(el('div', null, money(s)));
      const dollars = usd(s);
      if (dollars) priceCol.append(el('div', 'usd', '≈ ' + dollars));
      card.append(el('div', 'svc-name', s.name), priceCol);
      card.onclick = () => {
        $('#orderCountry').value = $('#catalogCountry').value;
        loadServices($('#orderCountry').value).then(() => {
          $('#serviceSearch').value = s.name;
          renderServiceOptions();
          $('#orderService').value = String(s.id);
          updatePricePreview();
        });
        document.querySelector('.tab[data-view="order"]').click();
      };
      list.append(card);
    });
  } catch (err) {
    list.innerHTML = '<div class="empty">Could not load the catalog.</div>';
    errToast(err);
  }
}

$('#catalogCountry').addEventListener('change', loadCatalog);
$('#catalogSearch').addEventListener('input', () => {
  clearTimeout(catalogTimer);
  catalogTimer = setTimeout(loadCatalog, 300);
});

// ---------------- boot ----------------

fillCountrySelects();
// The rate is fetched first so every price renders with its USD figure already.
loadFx().then(() => {
  loadAccount();
  loadServices($('#orderCountry').value);
  loadRentalPackages();
  resumeOpenOrder();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (state.activeOrder && state.activeOrder.status === 'pending') pollActiveOrder();
});
