'use strict';
// ====== tiny helpers ======
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const qtyf = n => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayStr = () => ymd(new Date());
const dt = s => s ? new Date(s.includes('T') || s.length > 10 ? s.replace(' ', 'T') + (s.includes('Z') || s.length <= 10 ? '' : 'Z') : s + 'T00:00:00').toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: s.length > 10 ? '2-digit' : undefined, minute: s.length > 10 ? '2-digit' : undefined }) : '';
let me = null, cache = {};
const curProp = () => { let v = 'all'; try { v = localStorage.getItem('prop') || 'all'; } catch { } const ps = me?.properties || []; if (ps.length === 1) return String(ps[0].id); return ps.some(p => String(p.id) === v) ? v : 'all'; };
const setProp = v => { try { localStorage.setItem('prop', String(v)); } catch { } };
const needsPick = () => (me?.properties || []).length > 1 && curProp() === 'all';
const propField = () => needsPick() ? [{ n: 'property_id', label: 'Property', type: 'select', blank: '— choose property —', req: true, opts: me.properties.map(p => [p.id, p.name]) }] : [];
const propName = () => curProp() === 'all' ? 'All properties' : (me.properties.find(p => String(p.id) === curProp())?.name || '');

function toast(msg, isErr) { const t = $('#toast'); t.textContent = msg; t.className = 'show' + (isErr ? ' err' : ''); clearTimeout(toast.t); toast.t = setTimeout(() => t.className = '', 3200); }
async function api(method, url, body, isForm) {
  const opt = { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'hotel-app', 'X-Property': curProp() } };
  if (body !== undefined) { if (isForm) opt.body = body; else { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); } }
  const r = await fetch(url, opt);
  if (r.status === 401 && url !== '/api/login') { me = null; renderLogin(); throw new Error('Please sign in'); }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
const get = u => api('GET', u), post = (u, b) => api('POST', u, b || {}), put = (u, b) => api('PUT', u, b);
const can = (...roles) => me && (me.role === 'admin' || roles.includes(me.role));
async function guard(fn) { try { return await fn(); } catch (e) { if (e.message !== 'Please sign in') toast(e.message, true); } }

// ====== forms & modals ======
function field(f) {
  const v = f.value ?? '';
  let inp;
  if (f.type === 'select') inp = `<select name="${f.n}" ${f.req ? 'required' : ''}>${f.blank ? '<option value="">' + esc(f.blank) + '</option>' : ''}${f.opts.map(o => { const [val, lab] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(lab)}</option>`; }).join('')}</select>`;
  else if (f.type === 'textarea') inp = `<textarea name="${f.n}" rows="2">${esc(v)}</textarea>`;
  else inp = `<input name="${f.n}" type="${f.type || 'text'}" value="${esc(v)}" ${f.req ? 'required' : ''} ${f.step ? `step="${f.step}"` : ''} ${f.min != null ? `min="${f.min}"` : ''} ${f.ph ? `placeholder="${esc(f.ph)}"` : ''} ${f.type === 'number' ? 'inputmode="decimal"' : ''} ${f.auto ? 'autofocus' : ''}>`;
  return `<div><label>${esc(f.label)}</label>${inp}</div>`;
}
const fields = fs => fs.map(field).join('');
function readForm(form) { const o = {}; new FormData(form).forEach((v, k) => { if (!(v instanceof File)) o[k] = v; }); return o; }
function modal(title, html, { onSubmit, submitLabel = 'Save', wide = false, hideSubmit = false } = {}) {
  closeModal();
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal ${wide ? 'wide' : ''}"><div class="row sb"><h2>${esc(title)}</h2><button class="btn sec sm" data-close>✕</button></div>
    <form id="mform">${html}<div class="err" id="merr"></div>${hideSubmit ? '' : `<div class="row" style="margin-top:14px"><button class="btn" type="submit">${esc(submitLabel)}</button><button class="btn sec" type="button" data-close>Cancel</button></div>`}</form></div></div>`;
  root.querySelector('.modal-bg').addEventListener('mousedown', e => { if (e.target.classList.contains('modal-bg')) closeModal(); });
  root.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal);
  const form = $('#mform');
  form.onsubmit = async e => {
    e.preventDefault(); if (!onSubmit) return;
    const btn = form.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
    try { await onSubmit(form, readForm(form)); } catch (er) { $('#merr').textContent = er.message; if (btn) btn.disabled = false; }
  };
  const first = form.querySelector('input:not([type=hidden]):not([type=file]),select'); if (first && !('ontouchstart' in window)) first.focus();
  return form;
}
function closeModal() { $('#modal-root').innerHTML = ''; }
function lightbox(src) { modal('Photo', `<img src="${esc(src)}" style="width:100%;border-radius:10px">`, { hideSubmit: true, wide: true }); }

// ====== image shrink for phone photos ======
async function shrink(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 300 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file); const s = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
    return blob && blob.size < file.size ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}

// ====== shell / routing ======
const ICON = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z', box: 'M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  tag: 'M20 12l-8 8-9-9V3h8zM7.5 7.5h.01', cart: 'M3 4h2l2.5 11h10L20 7H6.5M9 20h.01M17 20h.01', list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  bed: 'M3 19V6M3 14h18v5M21 14v-2a3 3 0 0 0-3-3h-7v5M7 11h.01', scan: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16',
  check: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h9', barcode: 'M4 5v14M7 5v14M11 5v14M14 5v14M17 5v14M20 5v14',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6', chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12h2M3 12h2M12 3v2M12 19v2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0', plus: 'M12 5v14M5 12h14', search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5', menu: 'M4 6h16M4 12h16M4 18h16',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', tool: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z',
  wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l2-3h12v3M16 13h.01', clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', users: 'M16 11a3 3 0 1 0 0-6M3 20a6 6 0 0 1 12 0M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM17 14a6 6 0 0 1 4 6'
};
const ic = (n, s = 18) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON[n]}"/></svg>`;
const MENU = [
  ['home', 'Dashboard', 'home'],
  ['_', 'Inventory'], ['stock', 'Stock items', 'box'], ['assets', 'Assets', 'tag'], ['restock', 'Restock list', 'list'], ['po', 'Purchasing', 'cart'],
  ['_', 'Operations'], ['rooms', 'Rooms', 'bed'], ['audit', 'Room audit', 'check'], ['scan', 'Scan', 'scan'], ['labels', 'Barcode labels', 'barcode'],
  ['_', 'Finance'], ['expenses', 'Expenses', 'receipt'],
  ['_', 'Insights'], ['reports', 'Reports', 'chart'], ['admin', 'Settings', 'gear', 'manager']
];
const MOBILE = [['home', 'Home', 'home'], ['scan', 'Scan', 'scan'], ['rooms', 'Rooms', 'bed'], ['stock', 'Stock', 'box'], ['expenses', 'Expenses', 'receipt'], ['more', 'More', 'menu']];
const ALIAS = { room: 'rooms', item: 'stock', asset: 'assets' };
const SIDE_EXTRA = [['audit', 'Room audit'], ['restock', 'Restock list'], ['po', 'Purchasing'], ['labels', 'Barcode labels'], ['reports', 'Reports'], ['admin', 'Settings']];
const initials = n => String(n || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();

function closePop() { const p = $('#pop'); if (p) p.remove(); }
function popMenu(anchor, html) {
  closePop();
  const p = document.createElement('div'); p.className = 'pop'; p.id = 'pop'; p.innerHTML = html; document.body.appendChild(p);
  const r = anchor.getBoundingClientRect(); p.style.position = 'fixed'; p.style.top = (r.bottom + 6) + 'px';
  p.style.right = Math.max(8, document.documentElement.clientWidth - r.right) + 'px';
  setTimeout(() => document.addEventListener('click', closePop, { once: true }), 0);
  return p;
}
window.changePw = () => modal('Change password', fields([{ n: 'current', label: 'Current password', type: 'password', req: true }, { n: 'next', label: 'New password (8+ characters)', type: 'password', req: true }]), { onSubmit: async (f, d) => { await post('/api/me/password', d); closeModal(); toast('Password changed'); } });
// ====== push notifications ======
const b64u = s => { const p = '='.repeat((4 - s.length % 4) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map(c => c.charCodeAt(0))); };
async function pushReg() { return 'serviceWorker' in navigator ? navigator.serviceWorker.register('/sw.js') : null; }
async function notifSettings() {
  const cfg = await get('/api/push/config');
  const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent), standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ok = cfg.supported && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let sub = null; if (ok) { const reg = await pushReg(); await navigator.serviceWorker.ready; sub = await reg.pushManager.getSubscription(); }
  const note = !cfg.supported ? 'Notifications are not available on this server.' : !ok ? (iOS && !standalone ? 'On iPhone/iPad: tap Share → <b>Add to Home Screen</b>, open the app from the home screen, then come back here.' : 'This browser does not support notifications.') : Notification.permission === 'denied' ? 'Notifications are blocked for this site. Allow them in your browser/site settings, then try again.' : '';
  const boxes = Object.entries(cfg.types).map(([k, v]) => `<label style="display:flex;gap:8px;align-items:flex-start;margin:6px 0;color:var(--ink);font-size:14px"><input type="checkbox" name="nt" value="${k}" style="width:auto;margin-top:3px" ${cfg.enabled.includes(k) ? 'checked' : ''}> ${esc(v)}</label>`).join('');
  modal('Notifications', `<p class="small">${sub ? '✅ This device will receive reminders.' : 'This device is <b>not</b> receiving reminders yet.'} ${cfg.devices ? `<span class="mute">(${cfg.devices} device(s) on your account)</span>` : ''}</p>${note ? `<p class="small" style="color:var(--amber)">${note}</p>` : ''}
    <div class="row">${ok ? (sub ? '<button type="button" class="btn sec sm" id="ntoff">Turn off on this device</button><button type="button" class="btn sec sm" id="nttest">Send a test</button>' : '<button type="button" class="btn sm" id="nton">Turn on for this device</button>') : ''}</div>
    <h3>Remind me about</h3>${boxes}<p class="small mute">Reminders go out at about 8:00 (briefing), 9:00 (stock), 9:30 (warranty), 10:00 and 17:00 (approvals), and instantly when a PMS checkout marks a room dirty.</p>`,
    { submitLabel: 'Save choices', onSubmit: async f => { await put('/api/push/prefs', { types: [...f.querySelectorAll('[name=nt]:checked')].map(x => x.value) }); closeModal(); toast('Saved'); } });
  if ($('#nton')) $('#nton').onclick = () => guard(async () => {
    if (await Notification.requestPermission() !== 'granted') return toast('Permission was not given', true);
    const reg = await pushReg(); await navigator.serviceWorker.ready;
    const s2 = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(cfg.key) });
    await post('/api/push/subscribe', s2.toJSON()); toast('Notifications are on'); notifSettings();
  });
  if ($('#ntoff')) $('#ntoff').onclick = () => guard(async () => { await post('/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); toast('Turned off on this device'); notifSettings(); });
  if ($('#nttest')) $('#nttest').onclick = () => guard(async () => { const r = await post('/api/push/test'); toast(r.sent ? 'Test sent' : 'Could not deliver the test', !r.sent); });
}
window.notifSettings = notifSettings;
async function doLogout() { await post('/api/logout'); me = null; renderLogin(); }

function renderShell() {
  $('#app').innerHTML = `<div class="shell"><nav class="side"><div class="logo"><img src="/logo.png" alt="Papppy Stays"></div>
    ${MENU.filter(m => !m[3] || can(m[3])).map(m => m[0] === '_' ? `<div class="grp">${m[1]}</div>` : `<a href="#/${m[0]}" data-nav="${m[0]}">${ic(m[2])}<span>${m[1]}</span></a>`).join('')}
    <div class="sp"></div><div class="who">${esc(me.name)} · ${esc(me.role)}</div></nav>
    <div class="content"><header class="topbar"><div class="brand-m"><img src="/favicon.png" alt="Papppy Stays"></div>
      ${(me.properties || []).length ? `<button class="propsw" id="psw" title="Switch property">${ic('bed', 15)}<span>${esc(propName())}</span>${me.properties.length > 1 ? '<b>▾</b>' : ''}</button>` : ''}
      <div class="gsearch"><span class="gs-ic">${ic('search', 16)}</span><input id="gs" placeholder="Search rooms, assets, items — or type a code" autocomplete="off"><div id="gsr" class="gs-res"></div></div>
      <div class="tb-right"><button class="iconbtn" id="bell" title="Notifications">${ic('bell', 19)}</button><button class="btn" id="quick">${ic('plus', 16)}<span class="qt">New</span></button><button class="avatar" id="usr" title="${esc(me.name)}">${esc(initials(me.name))}</button></div></header>
    <main class="main" id="view"></main></div></div>
    <nav class="bottom">${MOBILE.map(n => `<a href="#/${n[0]}" data-nav="${n[0]}">${ic(n[2], 21)}${n[1]}</a>`).join('')}</nav>`;
  $('#quick').onclick = e => {
    e.stopPropagation();
    const p = popMenu(e.currentTarget, `<a href="#/expenses/new">${ic('receipt', 16)} New expense</a>${can('manager') ? `<button data-a="item">${ic('box', 16)} New stock item</button><a href="#/assets">${ic('tag', 16)} Register assets</a><a href="#/po">${ic('cart', 16)} Purchase order</a>` : ''}<a href="#/audit">${ic('check', 16)} Room audit</a><a href="#/scan">${ic('scan', 16)} Scan a code</a>`);
    p.querySelectorAll('[data-a]').forEach(b => b.onclick = () => itemForm());
  };
  $('#bell').onclick = () => guard(notifSettings);
  $('#usr').onclick = e => {
    e.stopPropagation();
    const p = popMenu(e.currentTarget, `<div class="pi"><b>${esc(me.name)}</b><br>${esc(me.email)} · ${esc(me.role)}</div><button data-a="nt">🔔 Notifications</button><button data-a="pw">Change password</button><button data-a="out">Sign out</button>`);
    p.querySelector('[data-a=nt]').onclick = notifSettings; p.querySelector('[data-a=pw]').onclick = changePw; p.querySelector('[data-a=out]').onclick = doLogout;
  };
  if ($('#psw') && me.properties.length > 1) $('#psw').onclick = e => {
    e.stopPropagation();
    const cur = curProp();
    const p = popMenu(e.currentTarget, `<div class="pi mute small">Working in</div><button data-p="all" class="${cur === 'all' ? 'cur' : ''}">All properties</button>${me.properties.map(x => `<button data-p="${x.id}" class="${cur === String(x.id) ? 'cur' : ''}">${esc(x.name)}<span class="mute small"> ${esc(x.city || '')}</span></button>`).join('')}`);
    p.style.left = '8px'; p.style.right = 'auto';
    p.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { setProp(b.dataset.p); audit = null; renderShell(); route(); });
  };
  wireSearch();
}
// after scanning a code that belongs to another property, switch to it
function followProperty(r) { if (r.property_id && curProp() !== 'all' && String(r.property_id) !== curProp()) { setProp(r.property_id); renderShell(); toast('Switched to ' + propName()); } }
let gsT;
function wireSearch() {
  const inp = $('#gs'), box = $('#gsr'); const hide = () => box.classList.remove('on');
  inp.addEventListener('input', () => {
    clearTimeout(gsT);
    gsT = setTimeout(async () => {
      const q = inp.value.trim(); if (q.length < 2) return hide();
      const [items, assets, locs] = await Promise.all([get('/api/items?q=' + encodeURIComponent(q)).catch(() => []), get('/api/assets?q=' + encodeURIComponent(q)).catch(() => []), get('/api/locations').catch(() => [])]);
      const ql = q.toLowerCase(); const rooms = locs.filter(l => l.name.toLowerCase().includes(ql) || l.code.toLowerCase().includes(ql));
      const sec = (t, a, f) => a.length ? `<div class="gh">${t}</div>` + a.slice(0, 5).map(f).join('') : '';
      const html = sec('Rooms & places', rooms, l => `<a href="#/room/${l.id}"><span>${esc(l.name)}</span><span class="mute small">${esc(l.code)}</span></a>`) +
        sec('Assets', assets, a => `<a href="#/asset/${a.id}"><span>${esc(a.name)}</span><span class="mute small">${esc(a.tag)} · ${esc(a.location || '')}</span></a>`) +
        sec('Stock items', items, i => `<a href="#/item/${i.id}"><span>${esc(i.name)}</span><span class="mute small">${esc(i.sku || i.barcode || '')}</span></a>`);
      box.innerHTML = html || '<div class="empty">No matches</div>'; box.classList.add('on');
    }, 220);
  });
  inp.addEventListener('keydown', async e => {
    if (e.key === 'Enter') { const c = inp.value.trim(); if (!c) return; try { const r = await get('/api/resolve?code=' + encodeURIComponent(c)); followProperty(r); go(`#/${r.type === 'location' ? 'room' : r.type}/${r.id}`); inp.value = ''; hide(); } catch { } }
    if (e.key === 'Escape') { hide(); inp.blur(); }
  });
  document.addEventListener('click', e => { if (!e.target.closest('.gsearch')) hide(); });
  box.addEventListener('click', () => { inp.value = ''; hide(); });
}
function renderLogin(err) {
  $('#app').innerHTML = `<div class="login-wrap"><div class="login"><div class="login-logo"><img src="/logo.png" alt="Papppy Stays"></div><p style="text-align:center;margin-top:0;color:#aab6cc">Stock, assets &amp; expenses · sign in to continue</p>
  <form class="card" id="lf"><label>Email</label><input name="email" type="email" autocomplete="username" required autofocus><label>Password</label><input name="password" type="password" autocomplete="current-password" required>
  <div class="err">${esc(err || '')}</div><button class="btn big" style="width:100%;margin-top:14px;justify-content:center">Sign in</button></form></div></div>`;
  $('#lf').onsubmit = async e => { e.preventDefault(); try { await post('/api/login', readForm(e.target)); me = await get('/api/me'); renderShell(); route(); } catch (er) { renderLogin(er.message); } };
}
const routes = {};
async function route() {
  if (!me) return;
  stopScanner(); closePop();
  const [name, ...args] = (location.hash.replace(/^#\/?/, '').split('?')[0] || 'home').split('/');
  const key = ALIAS[name] || name;
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === key));
  const v = $('#view'); if (!v) return;
  const fn = routes[name] || routes.home;
  v.innerHTML = '<div class="empty">Loading…</div>';
  await guard(() => fn(v, ...args));
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
const go = h => { location.hash = h; };
const head = (title, actions = '') => `<div class="page-head"><h1>${title}</h1><div class="ph-actions">${actions}</div></div>`;
const statusTag = s => `<span class="tag ${{ clean: 'green', inspected: 'green', dirty: 'amber', maintenance: 'red' }[s] || ''}">${esc(s)}</span>`;
const condTag = c => `<span class="tag ${{ good: 'green', needs_repair: 'amber', under_repair: 'amber', missing: 'red', retired: '' }[c] || ''}">${esc(String(c).replace('_', ' '))}</span>`;
async function locOptions(types) { const l = await get('/api/locations'); return l.filter(x => !types || types.includes(x.type)).map(x => [x.id, `${x.name}${x.type !== 'room' ? ' (' + x.type + ')' : ''}`]); }

// ====== HOME ======
routes.home = async v => {
  const priv = can('manager', 'accounts');
  const t = todayStr(), t3 = ymd(new Date(Date.now() + 3 * 864e5));
  const [d, bk, low, locs, exps] = await Promise.all([get('/api/dashboard'), get(`/api/bookings?from=${t}&to=${t3}`), get('/api/reports/lowstock'), get('/api/locations'), priv ? get('/api/expenses?status=pending') : Promise.resolve([])]);
  const K = (icon, n, l, href, cls = '') => `<a class="kpi ${cls}" href="${href}"><span class="ki">${ic(icon, 20)}</span><span><div class="n">${n}</div><div class="l">${l}</div></span></a>`;
  const moves = bk.filter(b => b.status !== 'blocked').flatMap(b => [
    b.checkin >= t && b.checkin <= t3 ? { room: b.room, id: b.location_id, guest: b.guest, ev: 'Arrives', date: b.checkin } : null,
    b.checkout >= t && b.checkout <= t3 ? { room: b.room, id: b.location_id, guest: b.guest, ev: 'Departs', date: b.checkout } : null]).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date) || a.room.localeCompare(b.room));
  const dirty = locs.filter(l => l.type === 'room' && l.status === 'dirty');
  const W = (title, link, body) => `<div class="card flush"><div class="ch"><h2>${title}</h2>${link || ''}</div>${body}</div>`;
  v.innerHTML = head('Dashboard · ' + esc(propName()), `<span class="mute small">${esc(new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}</span>`) +
    `<div class="kpis">
    ${K('bed', `${d.occupied}<span class="mute" style="font-size:14px;font-weight:500"> / ${d.rooms}</span>`, 'Rooms occupied', '#/rooms')}
    ${K('users', `${d.arrivals} · ${d.departures}`, 'Arrivals · Departures today', '#/rooms')}
    ${K('clock', d.dirty, 'Rooms to clean', '#/rooms', d.dirty ? 'warn' : 'good')}
    ${K('list', d.restock_lines, 'Restock lines needed', '#/restock', d.restock_lines ? 'warn' : 'good')}
    ${K('box', d.low_stock, 'Low stock items', '#/reports/low', d.low_stock ? 'bad' : 'good')}
    ${K('alert', d.missing_assets, 'Missing assets', '#/assets?c=missing', d.missing_assets ? 'bad' : 'good')}
    ${K('tool', d.assets_in_repair, 'Assets needing repair', '#/assets?c=needs_repair', d.assets_in_repair ? 'warn' : 'good')}
    ${priv ? K('wallet', money(d.month_spend), 'Spend this month', '#/expenses') : ''}
    ${priv ? K('receipt', d.pending_expenses.n, `Awaiting approval (${money(d.pending_expenses.t)})`, '#/expenses?s=pending', d.pending_expenses.n ? 'warn' : 'good') : ''}</div>
    ${d.by_property.length > 1 ? W('By property', '', `<div class="scroll"><table><tr><th>Property</th><th class="num">Occupied</th>${priv ? '<th class="num">Spend this month</th>' : ''}</tr>${d.by_property.map(p => `<tr class="click" onclick="pickProp(${p.id})"><td class="bold">${esc(p.name)}</td><td class="num">${p.occupied} / ${p.rooms}</td>${priv ? `<td class="num">${money(p.month_spend)}</td>` : ''}</tr>`).join('')}</table></div>`) : ''}
    <div class="cols">
    ${W('Arrivals & departures · next 3 days', '<a class="small" href="#/rooms">Rooms →</a>', moves.length ? `<div class="scroll"><table><tr><th>Date</th><th>Room</th><th>Guest</th><th></th></tr>${moves.slice(0, 8).map(m => `<tr class="click" onclick="go('#/room/${m.id}')"><td class="small">${esc(dt(m.date))}</td><td class="bold">${esc(m.room)}</td><td>${esc(m.guest || '—')}</td><td><span class="tag ${m.ev === 'Arrives' ? 'green' : 'amber'}">${m.ev}</span></td></tr>`).join('')}</table></div>` : '<div class="empty">No movements in the next 3 days.</div>')}
    ${W('Rooms to clean', '<a class="small" href="#/rooms">All rooms →</a>', dirty.length ? `<div style="padding:12px 16px">${dirty.map(r => `<a class="chip" style="text-decoration:none;color:inherit" href="#/room/${r.id}">${esc(r.name)}</a>`).join('')}</div>` : '<div class="empty">Every room is clean ✅</div>')}
    ${W('Low stock', '<a class="small" href="#/reports/low">View all →</a>', low.length ? `<div class="scroll"><table><tr><th>Item</th><th class="num">In stores</th><th class="num">Reorder at</th></tr>${low.slice(0, 6).map(i => `<tr class="click" onclick="go('#/item/${i.id}')"><td>${esc(i.name)}</td><td class="num bold" style="color:var(--red)">${qtyf(i.qty)}</td><td class="num">${qtyf(i.reorder_level)}</td></tr>`).join('')}</table></div>` : '<div class="empty">Nothing running low ✅</div>')}
    ${priv ? W('Expenses awaiting approval', '<a class="small" href="#/expenses?s=pending">Review →</a>', exps.length ? `<div class="scroll"><table><tr><th>Date</th><th>Details</th><th class="num">Amount</th></tr>${exps.slice(0, 6).map(e => `<tr class="click" onclick="go('#/expenses?s=pending')"><td class="small">${esc(e.date)}</td><td>${esc(e.vendor || e.category || '—')}<div class="small mute">${esc(e.submitted_name || '')}</div></td><td class="num bold">${money(e.amount)}</td></tr>`).join('')}</table></div>` : '<div class="empty">Nothing waiting 🎉</div>') : ''}
    </div>
    <p class="mute small" style="margin-top:6px">${d.last_sync ? 'Airbnb calendars last synced ' + esc(dt(d.last_sync.replace('T', ' ').slice(0, 19))) : 'Airbnb calendars not synced yet — add calendar links in Settings → Rooms.'}</p>`;
};

// ====== SCAN ======
let scanner = null, lastCode = '', lastAt = 0;
function stopScanner() { if (scanner) { const s = scanner; scanner = null; s.stop().then(() => s.clear()).catch(() => { }); } }
async function startScanner(elId, onCode) {
  if (!window.Html5Qrcode) return toast('Scanner library missing', true);
  if (!window.isSecureContext) { $('#' + elId).innerHTML = '<div class="empty">Camera needs a secure (https) connection. Use the box below with a handheld scanner, or type the code.</div>'; return; }
  stopScanner();
  const s = new Html5Qrcode(elId, { formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE, Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8, Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.CODE_39], verbose: false, useBarCodeDetectorIfSupported: true });
  scanner = s;
  try {
    await s.start({ facingMode: 'environment' }, { fps: 12, qrbox: { width: 300, height: 130 }, aspectRatio: 1.5 }, code => {
      const now = Date.now(); if (code === lastCode && now - lastAt < 2000) return; lastCode = code; lastAt = now;
      if (navigator.vibrate) navigator.vibrate(60); onCode(code);
    }, () => { });
  } catch (e) { scanner = null; $('#' + elId).innerHTML = `<div class="empty">Could not open the camera (${esc(e.message || e)}). Allow camera access in the browser, or type the code below.</div>`; }
}
async function resolveCode(code) {
  try { const r = await get('/api/resolve?code=' + encodeURIComponent(code)); followProperty(r); go(`#/${r.type === 'location' ? 'room' : r.type}/${r.id}`); }
  catch (e) { toast(e.message, true); }
}
routes.scan = async v => {
  v.innerHTML = head('Scan') + `<div class="card"><div id="reader"></div>
  <form id="manual" class="row" style="margin-top:12px"><input id="code" placeholder="Type or scan a code (A00012, R-101, barcode…)" autocomplete="off" style="flex:1" autofocus><button class="btn">Go</button></form>
  <p class="mute small">A handheld/Bluetooth scanner works here too — click the box and scan. Room labels open the room, asset labels open the asset, item barcodes open the stock item.</p></div>`;
  $('#manual').onsubmit = e => { e.preventDefault(); const c = $('#code').value.trim(); if (c) resolveCode(c); };
  startScanner('reader', resolveCode);
};

// ====== ROOMS ======
routes.rooms = async v => {
  const locs = await get('/api/locations');
  const rooms = locs.filter(l => l.type === 'room'), others = locs.filter(l => l.type !== 'room');
  const card = l => `<a class="room ${esc(l.status)}" href="#/room/${l.id}"><div class="row sb"><span class="nm">${esc(l.name)}</span>${statusTag(l.status)}</div>
    <div class="small mute">${esc(l.room_type || '')} ${l.floor ? '· Floor ' + esc(l.floor) : ''}</div>
    <div class="small" style="margin-top:4px">${l.occupied ? '🟢 ' + esc(l.guest || 'Occupied') : '<span class="mute">Vacant</span>'}</div></a>`;
  v.innerHTML = head('Rooms', can('manager') ? '<a class="btn sec sm" href="#/admin/locations">+ Add / edit</a>' : '') +
    (rooms.length ? `<div class="grid g3">${rooms.map(card).join('')}</div>` : '<div class="card empty">No rooms yet. Add them in Settings → Rooms.</div>') +
    `<h3>Stores & other places</h3><div class="grid g3">${others.map(l => `<a class="room" href="#/room/${l.id}"><span class="nm">${esc(l.name)}</span><div class="small mute">${esc(l.type)}</div></a>`).join('') || '<span class="mute">None</span>'}</div>`;
};
routes.room = async (v, id, tab = 'contents') => {
  const l = await get('/api/locations/' + id);
  const tabs = ['contents', 'bookings'].map(t => `<a class="${tab === t ? 'on' : ''}" href="#/room/${id}/${t}">${t[0].toUpperCase() + t.slice(1)}</a>`).join('');
  let body = '';
  if (tab === 'contents') {
    const exp = {}; l.template.filter(t => t.kind === 'asset').forEach(t => exp[t.item_id] = t);
    body = `<div class="card"><h2>Fixed assets (${l.assets.length})</h2>${l.assets.length ? `<div class="scroll"><table><tr><th>Tag</th><th>Item</th><th>Condition</th></tr>${l.assets.map(a => `<tr class="click" onclick="go('#/asset/${a.id}')"><td class="code">${esc(a.tag)}</td><td>${esc(a.name)}</td><td>${condTag(a.condition)}</td></tr>`).join('')}</table></div>` : '<p class="mute">No tagged assets here.</p>'}</div>
    <div class="card"><div class="row sb"><h2>Supplies in this place</h2>${l.type === 'room' ? `<a class="btn sec sm" href="#/restock?loc=${id}">Restock list</a>` : ''}</div>
    ${l.stock.length ? `<div class="scroll"><table><tr><th>Item</th><th class="r">Qty</th><th class="r">Par</th><th></th></tr>${l.stock.map(s => `<tr><td><a href="#/item/${s.item_id}">${esc(s.name)}</a></td><td class="r ${s.par > s.qty ? 'bold' : ''}" style="${s.par > s.qty ? 'color:var(--amber)' : ''}">${qtyf(s.qty)} ${esc(s.unit)}</td><td class="r mute">${s.par ? qtyf(s.par) : '—'}</td>
      <td class="r"><button class="btn sec sm" onclick="useStock(${s.item_id},${id})">Used</button></td></tr>`).join('')}</table></div>` : '<p class="mute">Nothing counted here yet.</p>'}</div>`;
  } else {
    body = `<div class="card">${l.bookings.length ? `<table><tr><th>Guest</th><th>In</th><th>Out</th><th>Source</th></tr>${l.bookings.map(b => `<tr><td>${esc(b.guest || '—')}</td><td>${dt(b.checkin)}</td><td>${dt(b.checkout)}</td><td><span class="tag ${b.source === 'airbnb' ? 'red' : 'blue'}">${esc(b.source)}</span> ${b.status === 'blocked' ? '<span class="tag">blocked</span>' : ''}</td></tr>`).join('')}</table>` : '<p class="mute">No upcoming bookings.</p>'}
    ${can('manager') ? `<button class="btn sec sm" onclick="addBooking(${id})" style="margin-top:8px">+ Manual booking</button>` : ''}</div>`;
  }
  v.innerHTML = head(`${esc(l.name)} ${l.type === 'room' ? statusTag(l.status) : ''}`, `<a class="btn sec sm" href="#/audit/${id}">Audit</a>${can('manager') ? `<a class="btn sec sm" href="#/labels?loc=${id}">Barcode</a>` : ''}`) +
    `<p class="mute small">${esc(l.room_type || '')} ${l.floor ? '· Floor ' + esc(l.floor) : ''} · code <span class="code">${esc(l.code)}</span></p>` +
    (l.type === 'room' ? `<div class="row" style="margin-bottom:12px">${['dirty', 'clean', 'inspected', 'maintenance'].map(s => `<button class="btn ${l.status === s ? '' : 'sec'} sm" onclick="setRoomStatus(${id},'${s}')">${s}</button>`).join('')}</div>` : '') +
    `<div class="tabs">${tabs}</div>` + body;
};
window.go = go;
window.pickProp = id => { setProp(id); renderShell(); route(); };
window.setRoomStatus = (id, s) => guard(async () => { await post(`/api/locations/${id}/status`, { status: s }); toast('Updated'); route(); });
window.useStock = (item_id, loc) => modal('Record usage', fields([{ n: 'qty', label: 'How many used / restocked out?', type: 'number', step: 'any', req: true, auto: true, value: 1 }, { n: 'note', label: 'Note (optional)' }]), {
  submitLabel: 'Record', onSubmit: async (f, d) => { await post('/api/stock/consume', { item_id, location_id: loc, qty: d.qty, note: d.note }); closeModal(); toast('Recorded'); route(); }
});
window.addBooking = loc => modal('Manual booking', fields([{ n: 'guest', label: 'Guest name' }, { n: 'checkin', label: 'Check-in', type: 'date', req: true, value: todayStr() }, { n: 'checkout', label: 'Check-out', type: 'date', req: true }]), {
  onSubmit: async (f, d) => { await post('/api/bookings', { ...d, location_id: loc }); closeModal(); route(); }
});

// ====== STOCK (consumables) ======
routes.stock = async v => {
  const [items, low] = await Promise.all([get('/api/items?kind=consumable'), get('/api/reports/lowstock')]);
  const lowIds = new Set(low.map(l => l.id));
  const cats = [...new Set(items.map(i => i.category || 'Other'))].sort();
  v.innerHTML = head('Stock items', can('manager') ? `<button class="btn" id="newitem">${ic('plus', 16)} New item</button>` : '') +
    `<div class="card flush"><div class="toolbar"><input class="grow" id="q" placeholder="Search by name, SKU or barcode…"><select id="cat"><option value="">All categories</option>${cats.map(c => `<option>${esc(c)}</option>`).join('')}</select></div><div class="scroll" id="list"></div></div>`;
  const draw = () => {
    const q = $('#q').value.toLowerCase(), c = $('#cat').value;
    const rows = items.filter(i => (!c || (i.category || 'Other') === c) && (!q || [i.name, i.sku, i.barcode].some(x => (x || '').toLowerCase().includes(q))));
    $('#list').innerHTML = rows.length ? `<table><tr><th>Name</th><th class="hm">SKU</th><th class="hm">Barcode</th><th class="hm">Category</th><th class="num">On hand</th><th class="num hm">Reorder at</th><th></th></tr>${rows.map(i => `<tr class="click" onclick="go('#/item/${i.id}')"><td class="bold">${esc(i.name)}</td><td class="small hm">${esc(i.sku || '—')}</td><td class="hm"><span class="code">${esc(i.barcode || '')}</span></td><td class="hm">${esc(i.category || 'Other')}</td><td class="num bold">${qtyf(i.total_qty)} <span class="mute small">${esc(i.unit)}</span></td><td class="num hm">${i.reorder_level ? qtyf(i.reorder_level) : '—'}</td><td>${lowIds.has(i.id) ? '<span class="tag red">Low</span>' : ''}</td></tr>`).join('')}</table>` : '<div class="empty">No items found.</div>';
  };
  $('#q').oninput = draw; $('#cat').onchange = draw; draw();
  if ($('#newitem')) $('#newitem').onclick = () => itemForm();
};
async function itemForm(it) {
  const sups = await get('/api/suppliers');
  modal(it ? 'Edit item' : 'New item', fields([
    { n: 'name', label: 'Name', req: true, value: it?.name }, { n: 'category', label: 'Category (e.g. Linen, Minibar, Amenities)', value: it?.category },
    ...(it ? [] : [{ n: 'kind', label: 'Type', type: 'select', opts: [['consumable', 'Counted by quantity (soap, water, towels)'], ['asset', 'Individually tagged asset (TV, kettle, safe)']] }]),
    { n: 'unit', label: 'Unit', value: it?.unit || 'pcs' }, { n: 'sku', label: 'SKU (optional)', value: it?.sku }, { n: 'barcode', label: 'Barcode (leave blank to auto-generate; scan the product’s own barcode if it has one)', value: it?.barcode },
    { n: 'cost', label: 'Unit cost (₹)', type: 'number', step: 'any', value: it?.cost }, { n: 'reorder_level', label: 'Reorder when store stock falls to', type: 'number', step: 'any', value: it?.reorder_level },
    { n: 'supplier_id', label: 'Supplier', type: 'select', blank: '— none —', opts: sups.map(s => [s.id, s.name]), value: it?.supplier_id }
  ]), { onSubmit: async (f, d) => { it ? await put('/api/items/' + it.id, d) : await post('/api/items', d); closeModal(); toast('Saved'); route(); } });
}
routes.item = async (v, id) => {
  const i = await get('/api/items/' + id);
  const isC = i.kind === 'consumable';
  v.innerHTML = head(esc(i.name), can('manager') ? '<button class="btn sec sm" id="edit">Edit</button>' : '') +
    `<p class="mute small">${esc(i.category || '')} · barcode <span class="code">${esc(i.barcode || '')}</span> · ${money(i.cost)} each</p>` +
    (isC ? `<div class="row" style="margin-bottom:12px">${can('manager', 'housekeeping') ? '<button class="btn sm" id="rcv">+ Receive</button><button class="btn sec sm" id="iss">Write off / issue</button>' : ''}<button class="btn sec sm" id="trf">Transfer</button>${can('manager') ? '<button class="btn sec sm" id="adj">Correct count</button>' : ''}<a class="btn sec sm" href="#/labels?item=${id}">Barcode label</a></div>
    <div class="card"><h2>Where it is</h2>${i.stock.length ? `<div class="scroll"><table><tr><th>Location</th><th class="r">Qty</th><th class="r">Par</th>${can('manager') ? '<th></th>' : ''}</tr>${i.stock.map(s => `<tr><td>${esc(s.location)}</td><td class="r bold">${qtyf(s.qty)}</td><td class="r">${s.par ? qtyf(s.par) : '—'}</td>${can('manager') ? `<td class="r"><button class="btn sec sm" onclick="setPar(${id},${s.location_id},${s.par})">Par</button></td>` : ''}</tr>`).join('')}</table></div>` : '<p class="mute">No stock yet — receive some.</p>'}</div>`
    : `<div class="card"><h2>Tagged units (${i.assets.length})</h2>${can('manager') ? `<button class="btn sm" onclick="assetForm(${id})">+ Add units</button>` : ''}<table>${i.assets.map(a => `<tr class="click" onclick="go('#/asset/${a.id}')"><td class="code">${esc(a.tag)}</td><td>${esc(a.location || '—')}</td><td>${condTag(a.condition)}</td></tr>`).join('')}</table></div>`) +
    `<div class="card"><h2>Recent activity</h2>${movTable(i.history)}</div>`;
  if ($('#edit')) $('#edit').onclick = () => itemForm(i);
  const pick = async (title, extra, fn) => { const locs = await locOptions(); modal(title, fields([{ n: 'location_id', label: 'Location', type: 'select', opts: locs, value: locs.find(l => l[1].startsWith('Main'))?.[0] }, ...extra]), { onSubmit: async (f, d) => { await fn(d); closeModal(); toast('Done'); route(); } }); };
  if ($('#rcv')) $('#rcv').onclick = () => pick('Receive stock', [{ n: 'qty', label: 'Quantity received', type: 'number', step: 'any', req: true }, { n: 'note', label: 'Note / invoice no.' }], d => post('/api/stock/receive', { ...d, item_id: id }));
  if ($('#iss')) $('#iss').onclick = () => pick('Write off / issue', [{ n: 'qty', label: 'Quantity', type: 'number', step: 'any', req: true }, { n: 'note', label: 'Reason', req: true }], d => post('/api/stock/issue', { ...d, item_id: id }));
  if ($('#adj')) $('#adj').onclick = () => pick('Correct count', [{ n: 'new_qty', label: 'Counted quantity', type: 'number', step: 'any', req: true }, { n: 'note', label: 'Reason', req: true }], d => post('/api/stock/adjust', { ...d, item_id: id }));
  if ($('#trf')) $('#trf').onclick = async () => { const locs = await locOptions(); modal('Transfer', fields([{ n: 'from_loc', label: 'From', type: 'select', opts: locs }, { n: 'to_loc', label: 'To', type: 'select', opts: locs }, { n: 'qty', label: 'Quantity', type: 'number', step: 'any', req: true }]), { onSubmit: async (f, d) => { await post('/api/stock/transfer', { ...d, item_id: id, from_loc: +d.from_loc, to_loc: +d.to_loc }); closeModal(); route(); } }); };
};
window.setPar = (item_id, location_id, par) => modal('Par level', fields([{ n: 'par', label: 'Keep this many here', type: 'number', step: 'any', value: par, req: true, min: 0 }]), { onSubmit: async (f, d) => { await put('/api/stock/par', { item_id, location_id, par: d.par }); closeModal(); route(); } });
function movTable(rows) {
  if (!rows.length) return '<p class="mute">Nothing yet.</p>';
  return `<div class="scroll"><table><tr><th>When</th><th>What</th><th>By</th></tr>${rows.map(m => `<tr><td class="small">${esc(dt(m.ts))}</td><td class="small"><span class="tag">${esc(m.type.replace('_', ' '))}</span> ${m.item ? esc(m.item) + ' ' : ''}${m.tag ? '<span class="code">' + esc(m.tag) + '</span> ' : ''}${m.qty != null ? qtyf(m.qty) + ' ' : ''}${m.from_name ? esc(m.from_name) + ' ' : ''}${m.from_name || m.to_name ? '→ ' : ''}${esc(m.to_name || '')}${m.note ? '<div class="mute">' + esc(m.note) + '</div>' : ''}</td><td class="small mute">${esc(m.user || '')}</td></tr>`).join('')}</table></div>`;
}

// ====== ASSETS ======
routes.assets = async v => {
  const q0 = new URLSearchParams((location.hash.split('?')[1]) || '');
  const items = (await get('/api/items?kind=asset'));
  v.innerHTML = head('Assets', can('manager') ? '<button class="btn sm" id="newasset">+ Register assets</button><button class="btn sec sm" id="newkind">+ New asset type</button>' : '') +
    `<div class="row" style="margin-bottom:10px"><input id="q" placeholder="Search tag, name, serial…" style="flex:2;min-width:150px"><select id="cond" style="flex:1;min-width:120px"><option value="">Any condition</option>${['good', 'needs_repair', 'under_repair', 'missing', 'retired'].map(c => `<option ${q0.get('c') === c ? 'selected' : ''} value="${c}">${c.replace('_', ' ')}</option>`).join('')}</select></div><div id="list" class="card scroll"></div>`;
  const draw = async () => {
    const rows = await get(`/api/assets?q=${encodeURIComponent($('#q').value)}&condition=${$('#cond').value}`);
    $('#list').innerHTML = rows.length ? `<table><tr><th>Tag</th><th>Item</th><th>Location</th><th>Condition</th></tr>${rows.map(a => `<tr class="click" onclick="go('#/asset/${a.id}')"><td class="code">${esc(a.tag)}</td><td>${esc(a.name)}</td><td>${esc(a.location || '—')}</td><td>${condTag(a.condition)}</td></tr>`).join('')}</table>` : '<div class="empty">No assets found.</div>';
  };
  let tm; $('#q').oninput = () => { clearTimeout(tm); tm = setTimeout(() => guard(draw), 250); }; $('#cond').onchange = () => guard(draw); await draw();
  if ($('#newasset')) $('#newasset').onclick = () => items.length ? assetForm() : toast('Create an asset type first (e.g. “Television 43in”)', true);
  if ($('#newkind')) $('#newkind').onclick = () => itemForm();
};
window.assetForm = async item_id => {
  const items = await get('/api/items?kind=asset'); const locs = await locOptions();
  modal('Register assets', fields([{ n: 'item_id', label: 'Asset type', type: 'select', opts: items.map(i => [i.id, i.name]), value: item_id }, { n: 'location_id', label: 'Where is it', type: 'select', opts: locs },
    { n: 'count', label: 'How many identical units (each gets its own tag)', type: 'number', value: 1, min: 1 }, { n: 'serial', label: 'Serial number (single unit only)' },
    { n: 'purchase_date', label: 'Purchase date', type: 'date' }, { n: 'warranty_until', label: 'Warranty until', type: 'date' }, { n: 'cost', label: 'Cost per unit (₹, blank = item cost)', type: 'number', step: 'any' }]),
    { onSubmit: async (f, d) => { const r = await post('/api/assets', { ...d, cost: d.cost === '' ? undefined : +d.cost, count: +d.count }); closeModal(); toast(`${r.ids.length} asset(s) registered. Print their labels next.`); go('#/labels?assets=' + r.ids.join(',')); } });
};
routes.asset = async (v, id) => {
  const a = await get('/api/assets/' + id);
  v.innerHTML = head(`${esc(a.name)} <span class="code">${esc(a.tag)}</span>`, `<a class="btn sec sm" href="#/labels?assets=${id}">Label</a>`) +
    `<div class="card"><div class="row sb"><div><div class="mute small">Location</div><div class="bold">${esc(a.location || '—')}</div></div><div>${condTag(a.condition)}</div></div>
    <div class="f2" style="margin-top:10px"><div><div class="mute small">Serial</div>${esc(a.serial || '—')}</div><div><div class="mute small">Cost</div>${money(a.cost)}</div>
    <div><div class="mute small">Purchased</div>${esc(a.purchase_date || '—')}</div><div><div class="mute small">Warranty until</div>${esc(a.warranty_until || '—')}</div></div>
    <div class="row" style="margin-top:14px"><button class="btn" id="mv">Move</button><button class="btn sec" id="cd">Change condition</button></div></div>
    <div class="card"><h2>History</h2>${movTable(a.history.map(h => ({ ...h, item: null })))}</div>`;
  $('#mv').onclick = async () => { const locs = await locOptions(); modal('Move asset', fields([{ n: 'to_loc', label: 'Move to', type: 'select', opts: locs, value: a.location_id }, { n: 'note', label: 'Note' }]), { onSubmit: async (f, d) => { await post(`/api/assets/${id}/move`, { to_loc: +d.to_loc, note: d.note }); closeModal(); route(); } }); };
  $('#cd').onclick = () => modal('Condition', fields([{ n: 'condition', label: 'Condition', type: 'select', opts: ['good', 'needs_repair', 'under_repair', 'missing', ...(can('manager') ? ['retired'] : [])].map(c => [c, c.replace('_', ' ')]), value: a.condition }, { n: 'note', label: 'What happened?' }]), { onSubmit: async (f, d) => { await post(`/api/assets/${id}/condition`, d); closeModal(); route(); } });
};

// ====== ROOM AUDIT ======
let audit = null;
routes.audit = async (v, locId) => {
  if (!locId) {
    const rooms = (await get('/api/locations')).filter(l => l.type === 'room');
    v.innerHTML = head('Room audit') + `<p class="mute">Pick a room, then scan every tagged item you can see. The app lists what is missing, extra or damaged and lets you correct the records.</p><div class="grid g2">${rooms.map(r => `<a class="room ${esc(r.status)}" href="#/audit/${r.id}"><span class="nm">${esc(r.name)}</span></a>`).join('')}</div>`;
    return;
  }
  const l = await get('/api/locations/' + locId);
  if (!audit || audit.loc !== +locId) audit = { loc: +locId, tags: [], counts: {} };
  const countable = l.stock.filter(s => s.par > 0 || s.qty > 0);
  v.innerHTML = head('Audit · ' + esc(l.name)) +
    `<div class="card"><div id="reader"></div><form id="manual" class="row" style="margin-top:10px"><input id="code" placeholder="Type or scan an asset tag" autocomplete="off" style="flex:1"><button class="btn">Add</button></form></div>
    <div class="card"><h2>Scanned <span id="cnt" class="tag blue"></span></h2><div id="chips"></div></div>
    ${countable.length ? `<div class="card"><h2>Supplies count (optional)</h2><p class="mute small">Enter what you actually count. Leave blank to skip.</p>${countable.map(s => `<div class="row sb" style="margin:6px 0"><span>${esc(s.name)} <span class="mute small">(system: ${qtyf(s.qty)})</span></span><input data-c="${s.item_id}" type="number" step="any" inputmode="decimal" style="width:90px" value="${audit.counts[s.item_id] ?? ''}"></div>`).join('')}</div>` : ''}
    <button class="btn big" id="review" style="width:100%">Review results</button>`;
  const draw = () => { $('#cnt').textContent = audit.tags.length; $('#chips').innerHTML = audit.tags.map(t => `<span class="chip">${esc(t)}<button onclick="auditRm('${esc(t)}')">×</button></span>`).join('') || '<span class="mute small">Nothing scanned yet.</span>'; };
  const add = c => { c = c.trim(); if (!c) return; if (audit.tags.includes(c)) return toast('Already scanned'); audit.tags.push(c); toast('Added ' + c); draw(); };
  window.auditRm = t => { audit.tags = audit.tags.filter(x => x !== t); draw(); };
  $('#manual').onsubmit = e => { e.preventDefault(); add($('#code').value); $('#code').value = ''; };
  draw(); startScanner('reader', add);
  $('#review').onclick = () => guard(async () => {
    document.querySelectorAll('[data-c]').forEach(i => { if (i.value !== '') audit.counts[i.dataset.c] = +i.value; else delete audit.counts[i.dataset.c]; });
    stopScanner();
    const r = await post('/api/audit', { location_id: +locId, tags: audit.tags, counts: audit.counts, apply: false });
    const sec = (t, arr, fn, cls) => arr.length ? `<h3>${t} <span class="tag ${cls}">${arr.length}</span></h3>${arr.map(fn).join('')}` : '';
    const ok = !r.missing.length && !r.extra.length && !r.damaged.length && !r.shortfalls.length && !r.variances.length && !r.unknown_tags.length;
    modal('Audit result · ' + l.name, `<p>${r.scanned} item(s) scanned.</p>${ok ? '<div class="card" style="background:var(--green-l)">✅ Everything matches.</div>' : ''}
      ${sec('Missing from room', r.missing, a => `<div>${esc(a.name)} <span class="code">${esc(a.tag)}</span></div>`, 'red')}
      ${sec('Found here but recorded elsewhere', r.extra, a => `<div>${esc(a.name)} <span class="code">${esc(a.tag)}</span> <span class="mute small">was in ${esc(a.was_in)}</span></div>`, 'amber')}
      ${sec('Needs repair', r.damaged, a => `<div>${esc(a.name)} <span class="code">${esc(a.tag)}</span></div>`, 'amber')}
      ${sec('Room standard not met', r.shortfalls, s => `<div>${esc(s.name)}: expected ${s.expected}, found ${s.found}</div>`, 'red')}
      ${sec('Count differences', r.variances, s => `<div>${esc(s.name)}: system ${qtyf(s.system)}, counted ${qtyf(s.counted)}</div>`, 'amber')}
      ${sec('Unknown tags', r.unknown_tags, t => `<div class="code">${esc(t)}</div>`, 'red')}
      <p class="mute small">Saving marks missing items as “missing”, moves found items into this room and corrects supply counts.</p>`,
      { submitLabel: 'Save audit', wide: true, onSubmit: async () => { await post('/api/audit', { location_id: +locId, tags: audit.tags, counts: audit.counts, apply: true }); audit = null; closeModal(); toast('Audit saved'); go('#/room/' + locId); } });
  });
};

// ====== RESTOCK ======
routes.restock = async v => {
  const loc = new URLSearchParams(location.hash.split('?')[1] || '').get('loc');
  const { needs } = await get('/api/restock' + (loc ? '?location_id=' + loc : ''));
  const by = {}; needs.forEach(n => (by[n.room] ||= []).push(n));
  v.innerHTML = head('Restock list', can('manager', 'housekeeping') && needs.length ? '<button class="btn sm" id="fill">Fulfil from main store</button>' : '') +
    `<p class="mute small">What each room is short of compared with its par level. “Fulfil” moves the stock out of the main store into the rooms.</p>` +
    (Object.keys(by).length ? Object.entries(by).map(([r, rows]) => `<div class="card"><h2>${esc(r)}</h2>${rows.map(n => `<div class="row sb"><span>${esc(n.item)}</span><span class="bold">+${qtyf(n.need)} ${esc(n.unit)}</span></div>`).join('')}</div>`).join('') : '<div class="card empty">All rooms are at par 🎉</div>');
  if ($('#fill')) $('#fill').onclick = () => guard(async () => { const r = await post('/api/restock/fulfil', { location_id: loc || undefined }); toast(r.short.length ? `Done — ${r.short.length} line(s) short in store` : 'Rooms restocked'); route(); });
};

// ====== PURCHASING ======
routes.po = async v => {
  const pos = await get('/api/pos');
  v.innerHTML = head('Purchasing', can('manager', 'accounts') ? '<button class="btn sm" id="newpo">+ Purchase order</button><button class="btn sec sm" id="newsup">+ Supplier</button>' : '') +
    (pos.length ? pos.map(p => `<div class="card"><div class="row sb"><span class="bold">PO #${p.id} · ${esc(p.supplier || 'No supplier')}</span><span class="tag ${p.status === 'received' ? 'green' : p.status === 'open' ? 'blue' : ''}">${esc(p.status)}</span></div>
      <div class="small mute">${esc(dt(p.created_at))} · ${money(p.total)}</div>${p.lines.map(l => `<div class="small">${qtyf(l.qty)} × ${esc(l.name)} @ ${money(l.unit_cost)}</div>`).join('')}
      ${p.status === 'open' && can('manager') ? `<div class="row" style="margin-top:8px"><button class="btn sm" onclick="receivePo(${p.id})">Receive</button><button class="btn sec sm" onclick="cancelPo(${p.id})">Cancel</button></div>` : ''}</div>`).join('') : '<div class="card empty">No purchase orders yet.</div>');
  if ($('#newsup')) $('#newsup').onclick = () => modal('New supplier', fields([{ n: 'name', label: 'Name', req: true }, { n: 'phone', label: 'Phone' }, { n: 'email', label: 'Email' }]), { onSubmit: async (f, d) => { await post('/api/suppliers', d); closeModal(); toast('Added'); } });
  if ($('#newpo')) $('#newpo').onclick = async () => {
    const [sups, items] = await Promise.all([get('/api/suppliers'), get('/api/items')]);
    const form = modal('New purchase order', fields([...propField(), { n: 'supplier_id', label: 'Supplier', type: 'select', blank: '— choose —', opts: sups.map(s => [s.id, s.name]) }]) +
      `<div id="lines"></div><button type="button" class="btn sec sm" id="addl" style="margin-top:8px">+ Add line</button>`, {
      submitLabel: 'Create order', onSubmit: async (f, d) => {
        const lines = [...f.querySelectorAll('.pl')].map(r => ({ item_id: +r.querySelector('[name=item]').value, qty: r.querySelector('[name=q]').value, unit_cost: r.querySelector('[name=c]').value })).filter(l => l.item_id && l.qty);
        await post('/api/pos', { supplier_id: d.supplier_id || null, property_id: d.property_id, lines }); closeModal(); route();
      }
    });
    const addLine = () => { const d = document.createElement('div'); d.className = 'pl f2'; d.style.gridTemplateColumns = '2fr 1fr 1fr'; d.innerHTML = `<select name="item"><option value="">Item…</option>${items.map(i => `<option value="${i.id}" data-c="${i.cost}">${esc(i.name)}</option>`).join('')}</select><input name="q" type="number" step="any" placeholder="Qty"><input name="c" type="number" step="any" placeholder="₹ each">`; d.querySelector('select').onchange = e => { d.querySelector('[name=c]').value = e.target.selectedOptions[0].dataset.c || ''; }; $('#lines').appendChild(d); };
    $('#addl').onclick = addLine; addLine();
  };
};
window.receivePo = async id => { const locs = await locOptions(['store']); modal('Receive purchase order', fields([{ n: 'location_id', label: 'Into which store', type: 'select', opts: locs }, { n: 'create_expense', label: 'Also record as an expense (you can attach the invoice photo after)', type: 'select', opts: [['1', 'Yes'], ['', 'No']] }]), { submitLabel: 'Receive', onSubmit: async (f, d) => { const r = await post(`/api/pos/${id}/receive`, { location_id: +d.location_id, create_expense: !!d.create_expense }); closeModal(); toast('Stock received'); if (r.expense_id) go('#/expenses'); else route(); } }); };
window.cancelPo = id => guard(async () => { if (confirm('Cancel this order?')) { await post(`/api/pos/${id}/cancel`); route(); } });

// ====== EXPENSES ======
routes.expenses = async (v, sub) => {
  if (sub === 'new') return expenseForm(v);
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  const cats = await get('/api/expense-categories');
  const f = { from: qs.get('from') || todayStr().slice(0, 8) + '01', to: qs.get('to') || todayStr(), category: qs.get('c') || '', status: qs.get('s') || '' };
  const privileged = can('manager', 'accounts');
  v.innerHTML = head('Expenses', `<a class="btn" href="#/expenses/new">${ic('plus', 16)} Add expense</a>`) +
    `<div class="card flush"><div class="toolbar"><div><label style="margin:0 0 2px">From</label><input type="date" id="ef" value="${f.from}"></div><div><label style="margin:0 0 2px">To</label><input type="date" id="et" value="${f.to}"></div>
    <div><label style="margin:0 0 2px">Category</label><select id="ec"><option value="">All categories</option>${cats.map(c => `<option ${c === f.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
    <div><label style="margin:0 0 2px">Status</label><select id="es"><option value="">All statuses</option>${['pending', 'approved', 'rejected'].map(s => `<option ${s === f.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div></div></div>
    <div id="sum"></div><div id="list"></div>`;
  const draw = async () => {
    const p = new URLSearchParams({ from: $('#ef').value, to: $('#et').value, category: $('#ec').value, status: $('#es').value });
    const rows = await get('/api/expenses?' + p);
    if (privileged) {
      const s = await get('/api/expenses/summary?' + new URLSearchParams({ from: p.get('from'), to: p.get('to'), category: p.get('category') }));
      const max = Math.max(1, ...s.by_category.map(c => c.total));
      $('#sum').innerHTML = `<div class="card"><div class="row sb"><h2 style="margin:0">Total ${money(s.total)}</h2><a class="btn sec sm" href="/api/expenses.csv?${p}&prop=${curProp()}">⬇ CSV</a></div><div style="margin-top:8px">${s.by_category.map(c => `<div class="barrow"><span>${esc(c.category)}</span><div><div class="bar" style="width:${Math.max(3, c.total / max * 100)}%"></div></div><span class="r">${money(c.total)}</span></div>`).join('')}</div><p class="mute small" style="margin:6px 0 0">Excludes rejected expenses.</p></div>`;
    }
    const stTag = { approved: 'green', rejected: 'red', pending: 'amber' };
    $('#list').innerHTML = rows.length ? `<div class="card flush scroll"><table><tr><th>Date</th><th>Details</th><th>Category</th><th>Paid by</th><th class="num">Amount</th><th>Status</th><th>Receipt</th><th></th></tr>${rows.map(e => `<tr>
      <td class="small" style="white-space:nowrap">${esc(e.date)}</td>
      <td><div class="bold">${esc(e.vendor || '—')}</div><div class="small mute">${me.properties.length > 1 && e.property ? '<span class="tag">' + esc(e.property) + '</span> ' : ''}${esc(e.description || '')}${e.location ? ' · ' + esc(e.location) : ''}</div>${e.reject_reason ? `<div class="small" style="color:var(--red)">Rejected: ${esc(e.reject_reason)}</div>` : ''}</td>
      <td>${esc(e.category || '')}</td>
      <td class="small">${esc(e.submitted_name || '?')}<div class="mute">${esc(e.payment_method)}</div></td>
      <td class="num bold">${money(e.amount)}</td>
      <td><span class="tag ${stTag[e.status]}">${esc(e.status)}</span>${e.approved_name && e.status !== 'pending' ? `<div class="small mute">by ${esc(e.approved_name)}</div>` : ''}</td>
      <td><div class="thumbs">${e.photos.map(ph => `<img src="/uploads/${esc(ph.filename)}" loading="lazy" onclick="lightbox('/uploads/${esc(ph.filename)}')">`).join('')}${e.photos.length ? '' : '<span class="small" style="color:var(--amber)">None</span>'}</div></td>
      <td class="r" style="white-space:nowrap"><button class="btn sec sm" onclick="addPhotos(${e.id})" title="Add receipt photo">📷</button> ${(privileged || e.status === 'pending') ? `<button class="btn sec sm" onclick="editExpense(${e.id})">Edit</button> ` : ''}${privileged && e.status === 'pending' ? `<button class="btn sm" onclick="decide(${e.id},'approved')">Approve</button> <button class="btn red sm" onclick="decide(${e.id},'rejected')">Reject</button> ` : ''}${can('accounts') ? `<button class="btn sec sm" onclick="delExpense(${e.id})">Delete</button>` : ''}</td></tr>`).join('')}</table></div>` : '<div class="card empty">No expenses for these filters.</div>';
    window._exp = rows;
  };
  ['ef', 'et', 'ec', 'es'].forEach(i => $('#' + i).onchange = () => guard(draw)); await draw();
};
async function expenseForm(v, e) {
  const cats = await get('/api/expense-categories'); const locs = await locOptions(['room', 'store', 'other']);
  const html = `<form id="ef" class="card">${fields([{ n: 'amount', label: 'Amount (₹)', type: 'number', step: 'any', req: true, auto: true, value: e?.amount }, { n: 'date', label: 'Date', type: 'date', req: true, value: e?.date || todayStr() },
    { n: 'category', label: 'Category', type: 'select', opts: cats, req: true, value: e?.category }, { n: 'vendor', label: 'Paid to / vendor', value: e?.vendor },
    { n: 'payment_method', label: 'Paid by', type: 'select', opts: ['cash', 'upi', 'card', 'bank transfer', 'credit'], value: e?.payment_method }, { n: 'description', label: 'What was it for?', type: 'textarea', value: e?.description },
    { n: 'location_id', label: 'Related room / place (optional)', type: 'select', blank: '— none —', opts: locs, value: e?.location_id }, ...(e ? [] : propField())])}
    ${e ? '' : `<label>Receipt / bill photos</label><input type="file" id="ph" accept="image/*" capture="environment" multiple><input type="file" id="ph2" accept="image/*" multiple style="margin-top:6px"><div class="thumbs" id="prev"></div><p class="small mute">Take a photo of the bill now, or choose from your gallery. Photos are resized automatically.</p>`}
    <div class="err" id="eerr"></div><div class="row" style="margin-top:12px"><button class="btn big">${e ? 'Save' : 'Submit expense'}</button><a class="btn sec big" href="#/expenses">Cancel</a></div></form>`;
  if (v) v.innerHTML = head(e ? 'Edit expense' : 'New expense') + html; else modal('Edit expense', '', { hideSubmit: true });
  return html;
}
let pending = [];
const origExpenses = routes.expenses;
routes.expenses = async (v, sub) => {
  if (sub !== 'new') return origExpenses(v, sub);
  pending = []; await expenseForm(v);
  const prev = () => { $('#prev').innerHTML = pending.map((f, i) => `<span class="x"><img src="${URL.createObjectURL(f)}"><button type="button" onclick="rmPending(${i})">×</button></span>`).join(''); };
  window.rmPending = i => { pending.splice(i, 1); prev(); };
  for (const id of ['ph', 'ph2']) $('#' + id).onchange = async e => { for (const f of e.target.files) pending.push(await shrink(f)); e.target.value = ''; prev(); };
  $('#ef').onsubmit = async ev => {
    ev.preventDefault(); const btn = ev.target.querySelector('button.btn'); btn.disabled = true;
    try {
      const fd = new FormData(); Object.entries(readForm(ev.target)).forEach(([k, x]) => fd.append(k, x)); pending.forEach(f => fd.append('photos', f, f.name || 'photo.jpg'));
      if (!pending.length && !confirm('No receipt photo attached. Submit anyway?')) { btn.disabled = false; return; }
      await api('POST', '/api/expenses', fd, true); toast('Expense saved'); go('#/expenses');
    } catch (er) { $('#eerr').textContent = er.message; btn.disabled = false; }
  };
};
window.addPhotos = id => {
  const form = modal('Add receipt photo', `<input type="file" id="fp" accept="image/*" capture="environment" multiple><input type="file" id="fp2" accept="image/*" multiple style="margin-top:6px"><div class="thumbs" id="prev"></div>`, {
    submitLabel: 'Upload', onSubmit: async () => { if (!files.length) throw new Error('Choose a photo'); const fd = new FormData(); files.forEach(f => fd.append('photos', f, f.name || 'photo.jpg')); await api('POST', `/api/expenses/${id}/photos`, fd, true); closeModal(); toast('Uploaded'); route(); }
  });
  const files = []; for (const i of ['fp', 'fp2']) $('#' + i).onchange = async e => { for (const f of e.target.files) files.push(await shrink(f)); e.target.value = ''; $('#prev').innerHTML = files.map(f => `<img src="${URL.createObjectURL(f)}">`).join(''); };
};
window.editExpense = async id => {
  const e = window._exp.find(x => x.id === id); const cats = await get('/api/expense-categories'); const locs = await locOptions();
  modal('Edit expense', fields([{ n: 'amount', label: 'Amount (₹)', type: 'number', step: 'any', req: true, value: e.amount }, { n: 'date', label: 'Date', type: 'date', req: true, value: e.date }, { n: 'category', label: 'Category', type: 'select', opts: cats, value: e.category },
    { n: 'vendor', label: 'Vendor', value: e.vendor }, { n: 'payment_method', label: 'Paid by', type: 'select', opts: ['cash', 'upi', 'card', 'bank transfer', 'credit'], value: e.payment_method }, { n: 'description', label: 'Description', type: 'textarea', value: e.description }]) +
    (e.photos.length ? `<label>Photos</label><div class="thumbs">${e.photos.map(p => `<span class="x"><img src="/uploads/${esc(p.filename)}"><button type="button" onclick="delPhoto(${e.id},${p.id})">×</button></span>`).join('')}</div>` : ''),
    { onSubmit: async (f, d) => { await put('/api/expenses/' + id, d); closeModal(); route(); } });
};
window.delPhoto = (id, pid) => guard(async () => { if (confirm('Remove this photo?')) { await api('DELETE', `/api/expenses/${id}/photos/${pid}`); closeModal(); route(); } });
window.decide = (id, decision) => decision === 'approved' ? guard(async () => { await post(`/api/expenses/${id}/decision`, { decision }); route(); }) :
  modal('Reject expense', fields([{ n: 'reason', label: 'Reason', req: true }]), { submitLabel: 'Reject', onSubmit: async (f, d) => { await post(`/api/expenses/${id}/decision`, { decision, reason: d.reason }); closeModal(); route(); } });
window.delExpense = id => guard(async () => { if (confirm('Delete this expense and its photos permanently?')) { await api('DELETE', '/api/expenses/' + id); route(); } });
window.lightbox = lightbox;

// ====== LABELS ======
routes.labels = async v => {
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  const [locs, items, assets] = await Promise.all([get('/api/locations'), get('/api/items'), get('/api/assets')]);
  const preset = { assets: (qs.get('assets') || '').split(',').filter(Boolean).map(Number), loc: qs.get('loc'), item: qs.get('item') };
  let mode = preset.assets.length ? 'assets' : preset.loc ? 'rooms' : preset.item ? 'items' : 'rooms';
  const sel = new Set(preset.assets.map(i => 'a' + i)); if (preset.loc) sel.add('l' + preset.loc); if (preset.item) sel.add('i' + preset.item);
  const draw = () => {
    const src = mode === 'rooms' ? locs.map(l => ({ k: 'l' + l.id, code: l.code, name: l.name })) : mode === 'items' ? items.filter(i => i.kind === 'consumable').map(i => ({ k: 'i' + i.id, code: i.barcode, name: i.name })) : assets.filter(a => a.condition !== 'retired').map(a => ({ k: 'a' + a.id, code: a.tag, name: a.name + (a.location ? ' · ' + a.location : '') }));
    $('#pick').innerHTML = src.map(s => `<label style="display:flex;gap:8px;align-items:center;margin:2px 0;color:var(--ink);font-size:14px"><input type="checkbox" style="width:auto" data-k="${s.k}" ${sel.has(s.k) ? 'checked' : ''}> <span class="code">${esc(s.code)}</span> ${esc(s.name)}</label>`).join('');
    $('#pick').querySelectorAll('input').forEach(c => c.onchange = () => { c.checked ? sel.add(c.dataset.k) : sel.delete(c.dataset.k); render(); });
    render();
    function render() { const chosen = src.filter(s => sel.has(s.k)); $('#out').innerHTML = chosen.length ? chosen.map(s => `<div class="label"><img src="/api/barcode?text=${encodeURIComponent(s.code)}"><div class="c">${esc(s.code)}</div><div class="n">${esc(s.name)}</div></div>`).join('') : '<div class="empty noprint">Tick items on the left to preview labels.</div>'; $('#n').textContent = chosen.length; }
  };
  v.innerHTML = head('Print labels', '<button class="btn sm" onclick="window.print()">🖨 Print</button>') +
    `<div class="noprint tabs">${['rooms', 'assets', 'items'].map(m => `<a data-m="${m}" class="${mode === m ? 'on' : ''}">${m === 'rooms' ? 'Rooms & stores' : m === 'assets' ? 'Assets' : 'Stock items'}</a>`).join('')}</div>
    <div class="row noprint" style="align-items:flex-start"><div class="card" style="flex:1;min-width:260px;max-height:300px;overflow:auto" id="pick"></div><div class="card" style="flex:1;min-width:200px"><b id="n">0</b> label(s) selected<br><button class="btn sec sm" id="all" style="margin-top:8px">Select all shown</button> <button class="btn sec sm" id="none">Clear</button><p class="small mute">Code 128 barcodes work with phone cameras and any handheld scanner. Print at least 5 cm wide on matt sticker paper (glossy reflects light), and stick flat on the item, door frame or shelf.</p></div></div>
    <div class="labels" id="out"></div>`;
  v.querySelectorAll('[data-m]').forEach(a => a.onclick = () => { mode = a.dataset.m; v.querySelectorAll('[data-m]').forEach(x => x.classList.toggle('on', x === a)); draw(); });
  $('#all').onclick = () => { $('#pick').querySelectorAll('input').forEach(c => { c.checked = true; sel.add(c.dataset.k); }); draw(); };
  $('#none').onclick = () => { sel.clear(); draw(); };
  draw();
};

// ====== REPORTS ======
routes.reports = async (v, tab = 'low') => {
  const T = [['low', 'Low stock'], ['usage', 'Usage per night'], ['value', 'Valuation'], ['audits', 'Audits'], ['log', 'Activity log']];
  const tabs = `<div class="tabs">${T.map(t => `<a class="${tab === t[0] ? 'on' : ''}" href="#/reports/${t[0]}">${t[1]}</a>`).join('')}</div>`;
  let body = '';
  if (tab === 'low') { const r = await get('/api/reports/lowstock'); body = r.length ? `<div class="card scroll"><table><tr><th>Item</th><th class="r">In stores</th><th class="r">Reorder at</th><th>Supplier</th></tr>${r.map(i => `<tr class="click" onclick="go('#/item/${i.id}')"><td>${esc(i.name)}</td><td class="r bold" style="color:var(--red)">${qtyf(i.qty)}</td><td class="r">${qtyf(i.reorder_level)}</td><td>${esc(i.supplier)}</td></tr>`).join('')}</table></div>` : '<div class="card empty">Nothing is running low ✅</div>'; }
  if (tab === 'usage') {
    if (!can('manager', 'accounts')) throw new Error('Managers only');
    const qs = new URLSearchParams(location.hash.split('?')[1] || ''); const from = qs.get('from') || todayStr().slice(0, 8) + '01', to = qs.get('to') || todayStr();
    const r = await get(`/api/reports/consumption?from=${from}&to=${to}`);
    body = `<div class="card"><div class="f2"><div><label>From</label><input type="date" id="rf" value="${r.from}"></div><div><label>To</label><input type="date" id="rt" value="${r.to}"></div></div><p class="mute small">Occupied room-nights in period (from bookings): <b>${r.occupied_nights}</b></p>
      ${r.rows.length ? `<div class="scroll"><table><tr><th>Item</th><th class="r">Used</th><th class="r">Per occupied night</th><th class="r">Value</th></tr>${r.rows.map(x => `<tr><td>${esc(x.name)}</td><td class="r">${qtyf(x.used)} ${esc(x.unit)}</td><td class="r">${x.per_night == null ? '—' : x.per_night.toFixed(2)}</td><td class="r">${money(x.value)}</td></tr>`).join('')}</table></div>` : '<p class="mute">No usage recorded. Use “Used” in a room to record consumption.</p>'}</div>`;
  }
  if (tab === 'value') { const r = await get('/api/reports/valuation'); body = `<div class="card"><h2>Stock value by place</h2>${r.stock.map(s => `<div class="row sb"><span>${esc(s.location)}</span><b>${money(s.value)}</b></div>`).join('') || '<p class="mute">No stock</p>'}</div><div class="card"><h2>Fixed assets</h2>${r.assets.n} units · ${money(r.assets.value)} at cost</div>`; }
  if (tab === 'audits') { const r = await get('/api/audits'); body = r.length ? r.map(a => `<div class="card"><div class="row sb"><b>${esc(a.location)}</b><span class="small mute">${esc(dt(a.ts))} · ${esc(a.user)}</span></div><div class="small">${a.result.scanned} scanned · <span class="tag red">${a.result.missing.length} missing</span> <span class="tag amber">${a.result.extra.length} extra</span> <span class="tag amber">${a.result.variances.length} count diffs</span></div></div>`).join('') : '<div class="card empty">No audits saved yet.</div>'; }
  if (tab === 'log') { body = `<div class="card">${movTable(await get('/api/movements?limit=200'))}</div>`; }
  v.innerHTML = head('Reports') + tabs + body;
  if ($('#rf')) ['rf', 'rt'].forEach(i => $('#' + i).onchange = () => go(`#/reports/usage?from=${$('#rf').value}&to=${$('#rt').value}`));
};

// ====== MORE (mobile menu) ======
routes.more = async v => {
  v.innerHTML = head('More') + `<div class="grid g2">${SIDE_EXTRA.filter(n => n[0] !== 'admin' || can()).map(n => `<a class="stat" href="#/${n[0]}"><div class="bold">${n[1]}</div></a>`).join('')}</div>
  <div class="row" style="margin-top:14px"><button class="btn sec" id="pw">Change my password</button><button class="btn sec" id="lo">Sign out</button></div><p class="mute small">Signed in as ${esc(me.name)} (${esc(me.role)})</p>`;
  $('#lo').onclick = async () => { await post('/api/logout'); me = null; renderLogin(); };
  $('#pw').onclick = changePw;
};

// ====== ADMIN / SETTINGS ======
routes.admin = async (v, tab = 'locations') => {
  if (!can('manager')) throw new Error('Managers only');
  const T = [['locations', 'Rooms & places'], ['templates', 'Room standards'], ['integrations', 'Airbnb & PMS']].concat(can() ? [['properties', 'Properties'], ['users', 'Users']] : []);
  const tabs = `<div class="tabs">${T.map(t => `<a class="${tab === t[0] ? 'on' : ''}" href="#/admin/${t[0]}">${t[1]}</a>`).join('')}</div>`;
  let body = '';
  if (tab === 'locations') {
    const l = await get('/api/locations');
    body = `<button class="btn sm" id="addloc">+ Add room / place</button><button class="btn sec sm" id="bulk">+ Add many rooms</button><div class="card scroll" style="margin-top:10px"><table><tr><th>Name</th><th>Code</th><th>Type</th><th>Airbnb link</th><th></th></tr>${l.map(x => `<tr><td>${esc(x.name)}</td><td class="code">${esc(x.code)}</td><td>${esc(x.type)} ${esc(x.room_type || '')}</td><td>${x.ical_url ? '✅' : '—'}</td><td class="r"><button class="btn sec sm" onclick="editLoc(${x.id})">Edit</button></td></tr>`).join('')}</table></div>`;
    window._locs = l;
  }
  if (tab === 'templates') {
    const [t, items] = await Promise.all([get('/api/templates'), get('/api/items')]);
    const types = [...new Set([...t.types, ...t.rows.map(r => r.room_type)])];
    body = `<p class="mute small">The standard list of fixed assets for each room type. Room audits flag anything below this standard.</p>` + (types.length ? types.map(ty => `<div class="card"><div class="row sb"><b>${esc(ty)}</b><button class="btn sec sm" onclick="editTpl('${esc(ty)}')">Edit</button></div>${t.rows.filter(r => r.room_type === ty).map(r => `<div class="small">${qtyf(r.qty)} × ${esc(r.name)}</div>`).join('') || '<span class="mute small">Empty</span>'}</div>`).join('') : '<div class="card empty">Give rooms a “room type” first (e.g. Deluxe).</div>');
    window._items = items.filter(i => i.kind === 'asset'); window._tpl = t.rows;
  }
  if (tab === 'integrations') {
    const s = await get('/api/settings'); const store = await locOptions(['store']);
    window._pmsProps = await get('/api/properties');
    body = `<div class="card"><h2>Airbnb calendars</h2><ol class="small"><li>In Airbnb → Calendar → Availability → <b>Export calendar</b>, copy the link for the listing.</li><li>Open the matching room under <b>Rooms & places → Edit</b> and paste it in “Airbnb calendar link”.</li><li>Press the button below (it also syncs automatically every 30 minutes).</li></ol>
      <button class="btn" id="sync">Sync Airbnb now</button> <span class="small mute">Last sync: ${esc(s.last_sync || 'never')}</span><div id="syncres" class="small"></div></div>
      <div class="card"><h2>PMS connection</h2><p class="small">Your PMS (or its channel manager / Zapier) sends booking, check-in, check-out and room-status events to this address with your key:</p>
      <div class="small mute">Endpoint (POST, JSON)</div><div class="code">${esc(s.pms_endpoint)}</div><div class="small mute" style="margin-top:8px">Header <b>x-api-key</b></div><div class="code">${esc(s.pms_api_key)}</div>
      <div class="small mute" style="margin-top:8px">Property codes (add <b>"property":"CODE"</b> to an event when two properties use the same room names)</div><div class="code">${esc((window._pmsProps || []).map(p => p.code + ' = ' + p.name).join(' · '))}</div><div class="small mute" style="margin-top:8px">Example body</div><div class="code">{"event":"checkout","room":"R-101","uid":"RES123"}<br>{"event":"booking","room":"R-101","uid":"RES124","guest":"A Sharma","checkin":"2026-12-01","checkout":"2026-12-04"}<br>events: booking, checkin, checkout, cancel, room_status</div>
      <p class="small mute">“room” can be the room code, the room name, or the “PMS room ID” you set on the room. Checkout marks the room dirty so housekeeping sees it.</p><button class="btn sec sm" id="regen">Generate a new key</button></div>
      ${can() ? '<div class="card"><h2>Backup</h2><p class="small mute">Download a copy of all data (stock, assets, expenses). Do this regularly. Receipt photos live in the server’s data/uploads folder.</p><a class="btn sec sm" href="/api/backup">⬇ Download database backup</a></div>' : ''}
      <div class="card"><h2>Main store · ${esc(propName())}</h2><p class="small mute">Restock lists for this property are filled from this store.${needsPick() ? ' <b>Choose a single property in the top bar to set it.</b>' : ''}</p><select id="ms" ${needsPick() ? 'disabled' : ''}>${store.map(o => `<option value="${o[0]}" ${o[0] == s.main_store_id ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select></div>`;
  }
  if (tab === 'properties') {
    if (!can()) throw new Error('Admins only');
    const ps = await get('/api/properties'); window._props = ps;
    body = `<button class="btn sm" id="addprop">+ Add property</button><p class="small mute" style="margin-top:8px">Each property has its own rooms, stock, assets and expenses. Use the switcher in the top bar to work in one property or see all together.</p>` +
      ps.map(p => `<div class="card"><div class="row sb"><div><h2 style="margin:0">${esc(p.name)} <span class="code">${esc(p.code)}</span> ${p.active ? '' : '<span class="tag red">inactive</span>'}</h2><div class="small mute">${esc(p.legal_name || '')}</div></div><button class="btn sec sm" onclick="editProp(${p.id})">Edit details</button></div>
      <div class="f2" style="margin-top:10px"><div><div class="mute small">Address</div>${esc([p.address, p.city, p.state, p.pincode].filter(Boolean).join(', ') || '—')}</div><div><div class="mute small">Contact</div>${esc([p.phone, p.email].filter(Boolean).join(' · ') || '—')}</div>
      <div><div class="mute small">GSTIN</div>${esc(p.gstin || '—')}</div><div><div class="mute small">Check-in / out</div>${esc(p.checkin_time || '—')} / ${esc(p.checkout_time || '—')}</div></div>
      <div class="small mute" style="margin-top:8px">${p.rooms} rooms · ${p.stores} store(s)${p.notes ? ' · ' + esc(p.notes) : ''}</div></div>`).join('');
  }
  if (tab === 'users') {
    const u = await get('/api/users'); window._users = u; window._props = await get('/api/properties');
    body = `<button class="btn sm" id="adduser">+ Add user</button><div class="card scroll" style="margin-top:10px"><table>${u.map(x => `<tr><td>${esc(x.name)}<div class="small mute">${esc(x.email)}</div></td><td>${esc(x.role)} ${x.active ? '' : '<span class="tag red">off</span>'}<div class="small mute">${x.role === 'admin' || !x.property_ids ? 'All properties' : esc(String(x.property_ids).split(',').map(i => window._props.find(p => p.id == i)?.name).filter(Boolean).join(', '))}</div></td><td class="r"><button class="btn sec sm" onclick="editUser(${x.id})">Edit</button></td></tr>`).join('')}</table></div>
    <p class="small mute">Roles — <b>admin</b>: everything · <b>manager</b>: stock, assets, approvals, settings · <b>accounts</b>: expenses & purchasing · <b>housekeeping</b>: scan, use stock, audit rooms, submit own expenses.</p>`;
  }
  v.innerHTML = head('Settings') + tabs + body;
  const locForm = (x = {}) => modal(x.id ? 'Edit place' : 'Add room / place', fields([...(x.id ? [] : propField()), { n: 'name', label: 'Name', req: true, value: x.name }, { n: 'type', label: 'Type', type: 'select', opts: ['room', 'store', 'other'], value: x.type }, { n: 'room_type', label: 'Room type (Deluxe, Suite…)', value: x.room_type }, { n: 'floor', label: 'Floor', value: x.floor },
    { n: 'code', label: 'Barcode text (blank = auto, e.g. R-101)', value: x.code, ph: 'e.g. R-101' }, { n: 'ical_url', label: 'Airbnb calendar link (https://…)', value: x.ical_url }, { n: 'pms_room_id', label: 'PMS room ID', value: x.pms_room_id }].concat(x.id ? [{ n: 'active', label: 'Active', type: 'select', opts: [[1, 'Yes'], [0, 'No — hide']], value: x.active }] : [])),
    { onSubmit: async (f, d) => { x.id ? await put('/api/locations/' + x.id, { ...d, active: +d.active }) : await post('/api/locations', d); closeModal(); route(); } });
  window.editLoc = id => locForm(window._locs.find(l => l.id === id));
  if ($('#addloc')) $('#addloc').onclick = () => locForm();
  if ($('#bulk')) $('#bulk').onclick = () => modal('Add many rooms', fields([...propField(), { n: 'from', label: 'First room number', type: 'number', req: true, value: 101 }, { n: 'to', label: 'Last room number', type: 'number', req: true, value: 120 }, { n: 'room_type', label: 'Room type', value: 'Deluxe' }, { n: 'floor', label: 'Floor' }]), { onSubmit: async (f, d) => { const a = +d.from, b = +d.to; if (b < a || b - a > 200) throw new Error('Check the range'); for (let n = a; n <= b; n++) await post('/api/locations', { property_id: d.property_id, name: 'Room ' + n, code: 'R-' + n, type: 'room', room_type: d.room_type, floor: d.floor }).catch(() => { }); closeModal(); route(); } });
  window.editTpl = ty => { const cur = window._tpl.filter(r => r.room_type === ty); modal('Standard for ' + ty, window._items.map(i => `<div class="row sb" style="margin:6px 0"><span>${esc(i.name)}</span><input data-i="${i.id}" type="number" min="0" step="1" style="width:80px" value="${cur.find(c => c.item_id === i.id)?.qty || 0}"></div>`).join('') || '<p class="mute">Create asset types first.</p>', { onSubmit: async f => { await put('/api/templates/' + encodeURIComponent(ty), { lines: [...f.querySelectorAll('[data-i]')].map(x => ({ item_id: +x.dataset.i, qty: +x.value })) }); closeModal(); route(); } }); };
  if ($('#sync')) $('#sync').onclick = () => guard(async () => { $('#sync').disabled = true; const r = await post('/api/sync/ical'); $('#sync').disabled = false; $('#syncres').innerHTML = r.length ? r.map(x => `<div>${x.ok ? '✅' : '❌'} ${esc(x.room)} — ${x.ok ? x.events + ' events' : esc(x.error)}</div>`).join('') : 'No rooms have a calendar link yet.'; });
  if ($('#regen')) $('#regen').onclick = () => guard(async () => { if (confirm('The old key will stop working. Continue?')) { await put('/api/settings', { regenerate_key: true }); route(); } });
  if ($('#ms')) $('#ms').onchange = () => guard(async () => { await put('/api/settings', { main_store_id: $('#ms').value, property_id: curProp() === 'all' ? undefined : curProp() }); toast('Saved'); });
  const propBoxes = sel => `<label>Can work in</label><div>${(window._props || []).filter(p => p.active).map(p => `<label style="display:flex;gap:8px;align-items:center;margin:3px 0;color:var(--ink);font-size:14px"><input type="checkbox" name="pp" value="${p.id}" style="width:auto" ${(sel || []).includes(String(p.id)) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('')}</div><p class="small mute">Leave all unticked for access to every property. Admins always see all.</p>`;
  const picked = f => [...f.querySelectorAll('[name=pp]:checked')].map(x => +x.value);
  if ($('#adduser')) $('#adduser').onclick = () => modal('Add user', fields([{ n: 'name', label: 'Name', req: true }, { n: 'email', label: 'Email', type: 'email', req: true }, { n: 'password', label: 'Password (8+ characters)', type: 'password', req: true }, { n: 'role', label: 'Role', type: 'select', opts: ['housekeeping', 'accounts', 'manager', 'admin'] }]) + propBoxes([]), { onSubmit: async (f, d) => { await post('/api/users', { ...d, property_ids: picked(f) }); closeModal(); route(); } });
  const propForm = (p = {}) => modal(p.id ? 'Edit property' : 'Add property', fields([
    { n: 'name', label: 'Property name (shown in the app)', req: true, value: p.name }, { n: 'code', label: 'Short code (2-12 letters/digits, e.g. JPR1)', req: true, value: p.code },
    { n: 'legal_name', label: 'Legal / business name', value: p.legal_name }, { n: 'address', label: 'Address', type: 'textarea', value: p.address },
    { n: 'city', label: 'City', value: p.city }, { n: 'state', label: 'State', value: p.state }, { n: 'pincode', label: 'PIN code', value: p.pincode },
    { n: 'phone', label: 'Phone', value: p.phone }, { n: 'email', label: 'Email', type: 'email', value: p.email }, { n: 'gstin', label: 'GSTIN', value: p.gstin },
    { n: 'checkin_time', label: 'Standard check-in time', type: 'time', value: p.checkin_time || '12:00' }, { n: 'checkout_time', label: 'Standard check-out time', type: 'time', value: p.checkout_time || '11:00' },
    { n: 'notes', label: 'Notes', type: 'textarea', value: p.notes }].concat(p.id ? [{ n: 'active', label: 'Status', type: 'select', opts: [[1, 'Active'], [0, 'Inactive — hide everywhere']], value: p.active }] : [])),
    { onSubmit: async (f, d) => { if (p.id) await put('/api/properties/' + p.id, { ...d, active: +d.active }); else await post('/api/properties', d); me = await get('/api/me'); closeModal(); renderShell(); route(); toast('Saved'); } });
  window.editProp = id => propForm(window._props.find(p => p.id === id));
  if ($('#addprop')) $('#addprop').onclick = () => propForm();
  window.editUser = id => { const u = window._users.find(x => x.id === id); modal('Edit user', fields([{ n: 'name', label: 'Name', value: u.name }, { n: 'role', label: 'Role', type: 'select', opts: ['housekeeping', 'accounts', 'manager', 'admin'], value: u.role }, { n: 'active', label: 'Active', type: 'select', opts: [[1, 'Yes'], [0, 'No']], value: u.active }, { n: 'password', label: 'New password (leave blank to keep)', type: 'password' }]) + propBoxes(String(u.property_ids || '').split(',')), { onSubmit: async (f, d) => { const b = { name: d.name, role: d.role, active: +d.active, property_ids: picked(f) }; if (d.password) b.password = d.password; await put('/api/users/' + id, b); closeModal(); route(); } }); };
};

// ====== boot ======
if ('serviceWorker' in navigator) pushReg().catch(() => { });
(async () => { try { me = await get('/api/me'); renderShell(); route(); } catch { renderLogin(); } })();
