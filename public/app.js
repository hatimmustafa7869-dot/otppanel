/* OTP Panel — talks only to this server's /api/* proxy, never to smsotps directly. */

const POLL_MS = 4000;
const $ = (sel) => document.querySelector(sel);

const state = {
  providers: [],
  provider: null,
  countries: [],
  services: [],
  offers: [],
  activeOrder: null, // { id, phone, service, country, price }
  pollTimer: null,
  catalogCountries: [],
};

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
    const err = new Error(data.message || data.detail || data.title || ('HTTP ' + res.status));
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

// Prices and balance are plain USD decimals.
function money(value) {
  const n = Number(value && typeof value === 'object' ? value.amount : value);
  if (!isFinite(n)) return '—';
  return '$' + n.toFixed(2);
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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

function fillSelect(select, items, { value, label, placeholder }) {
  select.innerHTML = '';
  if (placeholder) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = placeholder;
    select.appendChild(opt);
  }
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = value(item);
    opt.textContent = label(item);
    select.appendChild(opt);
  }
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
  if (tab.dataset.view === 'services') initCatalog();
});

// ---------------- session / account ----------------

async function loadSession() {
  try {
    const info = await api('/session');
    if (info.auth_enabled && info.user) {
      const form = document.getElementById('logoutForm');
      if (form) {
        form.hidden = false;
        form.title = 'Signed in as ' + info.user;
      }
    }
  } catch { /* not fatal */ }
}

async function loadAccount() {
  const chip = $('#balanceChip');
  try {
    const acc = await api('/account');
    $('#balanceValue').textContent = money(acc.balance);
    chip.classList.remove('err');
    chip.title = 'smsotps balance (' + (acc.currency || 'USD') + ')';
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

// ---------------- catalog ----------------

async function loadProviders() {
  const res = await api('/providers');
  state.providers = res.data || [];
  state.provider = res.default || state.providers[0];

  const pretty = (p) => p.replace('provider_', 'Provider ').toUpperCase();
  fillSelect($('#orderProvider'), state.providers, { value: (p) => p, label: pretty });
  fillSelect($('#catalogProvider'), state.providers, { value: (p) => p, label: pretty });
  $('#orderProvider').value = state.provider;
  $('#catalogProvider').value = state.provider;
}

async function loadCountries() {
  const res = await api('/countries?provider=' + encodeURIComponent(state.provider));
  state.countries = res.data || [];
  renderCountryOptions();
}

function renderCountryOptions() {
  const term = $('#countrySearch').value.trim().toLowerCase();
  const list = term ? state.countries.filter((c) => c.name.toLowerCase().includes(term)) : state.countries;
  const previous = $('#orderCountry').value;

  fillSelect($('#orderCountry'), list, {
    value: (c) => c.id,
    label: (c) => c.name,
    placeholder: list.length ? null : 'No match',
  });
  if (previous && list.some((c) => c.id === previous)) $('#orderCountry').value = previous;
  else if (!previous) {
    const uk = list.find((c) => /united kingdom/i.test(c.name));
    if (uk) $('#orderCountry').value = uk.id;
  }
}

async function loadServices() {
  const res = await api('/services?provider=' + encodeURIComponent(state.provider));
  state.services = res.data || [];
  renderServiceOptions();
}

function renderServiceOptions() {
  const term = $('#serviceSearch').value.trim().toLowerCase();
  const list = term ? state.services.filter((s) => s.name.toLowerCase().includes(term)) : state.services;
  const previous = $('#orderService').value;

  // The catalog runs to ~1000 entries, so an unfiltered list is capped to keep
  // the dropdown usable; searching narrows it.
  const capped = list.slice(0, 300);
  fillSelect($('#orderService'), capped, {
    value: (s) => s.code,
    label: (s) => s.name,
    placeholder: capped.length ? null : 'No match',
  });
  if (previous && capped.some((s) => s.code === previous)) $('#orderService').value = previous;
}

// ---------------- offers ----------------

let offerTimer = null;

function scheduleOffers() {
  clearTimeout(offerTimer);
  offerTimer = setTimeout(loadOffers, 200);
}

async function loadOffers() {
  const service = $('#orderService').value;
  const country = $('#orderCountry').value;
  const btn = $('#orderBtn');

  state.offers = [];
  fillSelect($('#orderOperator'), [], { value: (o) => o, label: (o) => o, placeholder: 'Cheapest available' });

  if (!service || !country) {
    $('#pricePreview').textContent = 'Pick a service and country to see prices';
    btn.disabled = true;
    return;
  }

  $('#pricePreview').textContent = 'Checking price…';
  btn.disabled = true;

  try {
    const res = await api(
      '/offers?provider=' + encodeURIComponent(state.provider) +
      '&service=' + encodeURIComponent(service) +
      '&country=' + encodeURIComponent(country)
    );
    state.offers = res.data || [];

    if (!state.offers.length) {
      $('#pricePreview').innerHTML = '<b>Out of stock</b> for this combination — try another country';
      btn.disabled = true;
      return;
    }

    fillSelect($('#orderOperator'), state.offers, {
      value: (o) => o.operator,
      label: (o) => o.label + ' — ' + money(o.price) + ' (' + o.count + ')',
      placeholder: 'Cheapest available',
    });

    const cheapest = state.offers[0];
    $('#pricePreview').innerHTML =
      'From <b>' + money(cheapest.price) + '</b> · ' + cheapest.count + ' in stock' +
      (state.offers.length > 1 ? ' · ' + state.offers.length + ' operators' : '');
    btn.disabled = false;
  } catch (err) {
    $('#pricePreview').textContent = 'Could not load prices';
    btn.disabled = true;
    errToast(err);
  }
}

$('#orderProvider').addEventListener('change', async (e) => {
  state.provider = e.target.value;
  $('#orderCountry').value = '';
  $('#orderService').value = '';
  await Promise.all([loadCountries(), loadServices()]);
  scheduleOffers();
});
$('#countrySearch').addEventListener('input', () => { renderCountryOptions(); scheduleOffers(); });
$('#serviceSearch').addEventListener('input', () => { renderServiceOptions(); scheduleOffers(); });
$('#orderCountry').addEventListener('change', scheduleOffers);
$('#orderService').addEventListener('change', scheduleOffers);

// ---------------- ordering ----------------

$('#orderBtn').addEventListener('click', async () => {
  const btn = $('#orderBtn');
  const service = $('#orderService').value;
  const country = $('#orderCountry').value;
  const operator = $('#orderOperator').value;
  if (!service || !country) return;

  const chosen = operator
    ? state.offers.find((o) => o.operator === operator)
    : state.offers[0];

  btn.disabled = true;
  btn.textContent = 'Ordering…';
  try {
    const order = await api('/orders', {
      method: 'POST',
      body: {
        provider: state.provider,
        service,
        country,
        operator: operator || (chosen && chosen.operator),
        // Allow a little headroom in case the price moved since the quote.
        max_price: chosen ? Number((chosen.price * 1.25).toFixed(4)) : undefined,
      },
    });

    const id = order.id || order.order_id;
    const phone = order.number || order.phone;
    if (!id || !phone) throw new Error('The provider did not return a number.');

    const svc = state.services.find((s) => s.code === service);
    const ctry = state.countries.find((c) => c.id === country);
    setActiveOrder({
      id,
      phone,
      service: svc ? svc.name : service,
      country: ctry ? ctry.name : country,
      price: order.price !== undefined ? order.price : (chosen && chosen.price),
      status: order.status || 'pending',
      code: null,
    });
    toast('Number ordered', phone, 'ok');
    loadAccount();
  } catch (err) {
    errToast(err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Order number';
  }
});

function setActiveOrder(order) {
  state.activeOrder = order;
  localStorage.setItem('activeOrder', JSON.stringify(order));
  renderActiveOrder();
  startPolling();
}

function clearActiveOrder() {
  state.activeOrder = null;
  localStorage.removeItem('activeOrder');
  stopPolling();
  renderActiveOrder();
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(pollActiveOrder, POLL_MS);
}

function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function pollActiveOrder() {
  if (!state.activeOrder) return;
  try {
    const res = await api('/orders/' + encodeURIComponent(state.activeOrder.id));
    state.activeOrder.status = res.state || state.activeOrder.status;
    if (res.code) {
      state.activeOrder.code = res.code;
      state.activeOrder.text = res.text || null;
      stopPolling();
      toast('Code received', res.code, 'ok');
      loadAccount();
    } else if (['cancelled', 'canceled', 'expired', 'refunded'].includes(state.activeOrder.status)) {
      stopPolling();
    }
    renderActiveOrder();
  } catch (err) {
    console.warn('poll failed:', err.message);
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
    el('span', null, order.service + ' · ' + order.country),
    el('span', 'badge ' + (order.code ? 'completed' : order.status), order.code ? 'completed' : order.status)
  );
  head.append(title, el('div', 'muted small', money(order.price)));
  box.append(head);

  const phoneBox = el('div', 'phone-box');
  phoneBox.append(el('div', 'phone-number mono', '+' + String(order.phone).replace(/^\+/, '')));
  const copyPhone = el('button', 'btn small', 'Copy number');
  copyPhone.onclick = () => copy(String(order.phone), 'Number');
  phoneBox.append(copyPhone);
  box.append(phoneBox);

  if (order.code) {
    const codeBox = el('div', 'code-box');
    codeBox.append(el('div', 'code-label', 'Verification code'));
    codeBox.append(el('div', 'code-value', order.code));
    const copyCode = el('button', 'btn small', 'Copy code');
    copyCode.style.marginTop = '10px';
    copyCode.onclick = () => copy(order.code, 'Code');
    codeBox.append(copyCode);
    box.append(codeBox);

    if (order.text) {
      const msg = el('div', 'sms-msg');
      msg.append(el('div', 'sms-text', order.text));
      box.append(msg);
    }
  } else if (['cancelled', 'canceled', 'expired', 'refunded'].includes(order.status)) {
    box.append(el('div', 'empty', 'No code arrived — order ' + order.status + '.'));
  } else {
    const wait = el('div', 'waiting');
    wait.append(el('div', 'spinner'));
    const info = el('div');
    info.append(el('div', null, 'Waiting for SMS…'));
    info.append(el('div', 'muted small', 'This page checks every few seconds.'));
    wait.append(info);
    box.append(wait);
  }

  const actions = el('div', 'row end gap');
  actions.style.marginTop = '14px';

  if (order.code) {
    const again = el('button', 'btn small', 'Another SMS');
    again.title = 'Ask the provider for another code on this number';
    again.onclick = () => resendSms(order.id);
    actions.append(again);
    const done = el('button', 'btn small ghost', 'Clear');
    done.onclick = clearActiveOrder;
    actions.append(done);
  } else if (['cancelled', 'canceled', 'expired', 'refunded'].includes(order.status)) {
    const done = el('button', 'btn small ghost', 'Clear');
    done.onclick = clearActiveOrder;
    actions.append(done);
  } else {
    const cancel = el('button', 'btn small danger', 'Cancel');
    cancel.onclick = () => cancelOrder(order.id);
    actions.append(cancel);
  }
  box.append(actions);
}

async function cancelOrder(id) {
  try {
    await api('/orders/' + encodeURIComponent(id) + '/cancel', { method: 'POST' });
    toast('Canceled', 'The number was released', 'ok');
    clearActiveOrder();
    loadAccount();
    if ($('#view-orders').classList.contains('active')) loadOrders();
  } catch (err) {
    errToast(err);
  }
}

async function resendSms(id) {
  try {
    await api('/orders/' + encodeURIComponent(id) + '/resend', { method: 'POST' });
    toast('Requested', 'Waiting for another SMS', 'ok');
    if (state.activeOrder) {
      state.activeOrder.code = null;
      state.activeOrder.text = null;
      state.activeOrder.status = 'pending';
      renderActiveOrder();
      startPolling();
    }
  } catch (err) {
    errToast(err);
  }
}

function resumeActiveOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem('activeOrder') || 'null');
    if (!saved || !saved.id) return;
    state.activeOrder = saved;
    renderActiveOrder();
    if (!saved.code) startPolling();
  } catch { /* ignore a corrupt value */ }
}

// ---------------- order history ----------------

async function loadOrders(page) {
  const list = $('#ordersList');
  const pager = $('#ordersPager');
  list.innerHTML = '<div class="empty">Loading…</div>';
  pager.innerHTML = '';

  try {
    const res = await api('/orders?page=' + (page || 1));
    const rows = res.data || [];
    list.innerHTML = '';
    if (!rows.length) {
      list.innerHTML = '<div class="empty">No orders yet.</div>';
      return;
    }
    rows.forEach((o) => list.append(orderRow(o)));

    const p = res.pagination;
    if (p && p.lastPage > 1) {
      const info = el('div', 'muted small', 'Page ' + p.page + ' of ' + p.lastPage);
      pager.append(info);
      if (p.page < p.lastPage) {
        const more = el('button', 'btn ghost small', 'Next');
        more.style.marginLeft = '10px';
        more.onclick = () => loadOrders(p.page + 1);
        pager.append(more);
      }
      if (p.page > 1) {
        const prev = el('button', 'btn ghost small', 'Previous');
        prev.style.marginRight = '10px';
        prev.onclick = () => loadOrders(p.page - 1);
        pager.prepend(prev);
      }
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
  const svc = state.services.find((s) => s.code === o.service);
  const ctry = state.countries.find((c) => String(c.id) === String(o.country));
  title.append(
    el('span', null, (svc ? svc.name : o.service) + ' · ' + (ctry ? ctry.name : 'country ' + o.country)),
    el('span', 'badge ' + o.status, o.status)
  );
  if (o.sms_code) title.append(el('span', 'code-pill', o.sms_code));
  main.append(title);

  const parts = ['+' + o.phone, fmtTime(o.created_at), money(o.price)];
  if (o.refunded) parts.push('refunded');
  main.append(el('div', 'item-sub mono', parts.join(' · ')));
  row.append(main);

  const actions = el('div', 'item-actions');
  const cp = el('button', 'btn small ghost', 'Copy');
  cp.onclick = () => copy(String(o.phone), 'Number');
  actions.append(cp);
  if (o.sms_code) {
    const cc = el('button', 'btn small ghost', 'Copy code');
    cc.onclick = () => copy(String(o.sms_code), 'Code');
    actions.append(cc);
  }
  // The flag is set even on cancelled and expired rows, where another SMS can
  // only fail — offer it only where one actually arrived.
  if (o.can_get_another_sms && o.sms_code) {
    const again = el('button', 'btn small', 'Another SMS');
    again.onclick = () => resendSms(o.id);
    actions.append(again);
  }
  row.append(actions);
  return row;
}

$('#ordersRefresh').addEventListener('click', () => loadOrders());

// ---------------- prices tab ----------------

let catalogReady = false;
let catalogTimer = null;

async function initCatalog() {
  if (catalogReady) return;
  catalogReady = true;
  const res = await api('/countries?provider=' + encodeURIComponent($('#catalogProvider').value));
  state.catalogCountries = res.data || [];
  fillSelect($('#catalogCountry'), state.catalogCountries, { value: (c) => c.id, label: (c) => c.name });
  const uk = state.catalogCountries.find((c) => /united kingdom/i.test(c.name));
  if (uk) $('#catalogCountry').value = uk.id;
}

async function loadCatalog() {
  const list = $('#catalogList');
  const provider = $('#catalogProvider').value;
  const country = $('#catalogCountry').value;
  const search = $('#catalogSearch').value.trim();

  if (!search) {
    list.innerHTML = '';
    $('#catalogHint').textContent = 'Pick a country, then search for a service. Prices are looked up per service.';
    return;
  }

  $('#catalogHint').textContent = '';
  list.innerHTML = '<div class="empty">Searching…</div>';

  try {
    const res = await api(
      '/services?provider=' + encodeURIComponent(provider) + '&search=' + encodeURIComponent(search)
    );
    const services = (res.data || []).slice(0, 12);
    list.innerHTML = '';
    if (!services.length) {
      list.innerHTML = '<div class="empty">No services match that search.</div>';
      return;
    }

    // Prices are per service, so each card resolves its own price.
    for (const s of services) {
      const card = el('div', 'svc');
      card.append(el('div', 'svc-name', s.name));
      const priceCol = el('div', 'svc-price', '…');
      card.append(priceCol);
      card.title = 'Order ' + s.name;
      card.onclick = () => {
        $('#orderProvider').value = provider;
        state.provider = provider;
        Promise.all([loadCountries(), loadServices()]).then(() => {
          $('#orderCountry').value = country;
          $('#serviceSearch').value = s.name;
          renderServiceOptions();
          $('#orderService').value = s.code;
          scheduleOffers();
        });
        document.querySelector('.tab[data-view="order"]').click();
      };
      list.append(card);

      api('/offers?provider=' + encodeURIComponent(provider) +
          '&service=' + encodeURIComponent(s.code) +
          '&country=' + encodeURIComponent(country))
        .then((r) => {
          const offers = r.data || [];
          priceCol.textContent = offers.length ? money(offers[0].price) : 'out of stock';
          if (!offers.length) priceCol.classList.add('muted');
        })
        .catch(() => { priceCol.textContent = '—'; });
    }
  } catch (err) {
    list.innerHTML = '<div class="empty">Could not load the catalog.</div>';
    errToast(err);
  }
}

$('#catalogProvider').addEventListener('change', async () => {
  catalogReady = false;
  await initCatalog();
  loadCatalog();
});
$('#catalogCountry').addEventListener('change', loadCatalog);
$('#catalogSearch').addEventListener('input', () => {
  clearTimeout(catalogTimer);
  catalogTimer = setTimeout(loadCatalog, 350);
});

// ---------------- boot ----------------

(async () => {
  loadSession();
  try {
    await loadProviders();
    await Promise.all([loadCountries(), loadServices()]);
  } catch (err) {
    errToast(err);
  }
  loadAccount();
  resumeActiveOrder();
  scheduleOffers();
})();

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (state.activeOrder && !state.activeOrder.code) pollActiveOrder();
});
