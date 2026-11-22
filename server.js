process.env.TZ = process.env.TZ || 'Asia/Kolkata';
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const bwipjs = require('bwip-js');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, DATA_DIR, getSetting, setSetting } = require('./db');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// ---------- security ----------
// 1) headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) res.setHeader('Cache-Control', 'no-store');
  next();
});
// 2) drop scanner / bot probes (wp-admin, .env, .php ...) and ban repeat offenders for an hour
const strikes = new Map(), banned = new Map();
const PROBE = /(\.\.|\/\.|\.php|\.asp|\.env|\.git|wp-|xmlrpc|phpmyadmin|cgi-bin|\.sql|\.bak|\.zip|\.db$|\/vendor\/phpunit|actuator|boaform)/i;
app.use((req, res, next) => {
  const ip = req.ip, now = Date.now();
  const signedIn = (() => { try { return !!jwt.verify(parseCookies(req.headers.cookie).tok, SECRET); } catch { return false; } })();
  const b = banned.get(ip); if (b && b > now && !signedIn) return res.status(403).end(); if (b && b <= now) banned.delete(ip);
  let bad = PROBE.test((() => { try { return decodeURIComponent(req.path); } catch { return req.path + '/..'; } })());
  if (!bad && !['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(req.method)) bad = true;
  if (bad) {
    const n = (strikes.get(ip) || 0) + 1; strikes.set(ip, n);
    if (n >= 5 && !/^(127\.|::1|::ffff:127\.|10\.|192\.168\.)/.test(ip)) { banned.set(ip, now + 3600e3); console.warn(`[security] banned ${ip} for 1h (probing ${req.path})`); }
    return res.status(404).end();
  }
  next();
});
// 3) overall request-rate limit per IP (generous for real use, stops floods)
const hits = new Map();
setInterval(() => { hits.clear(); for (const [k, v] of strikes) if (!banned.has(k)) strikes.delete(k); }, 60e3).unref();
app.use((req, res, next) => {
  const n = (hits.get(req.ip) || 0) + 1; hits.set(req.ip, n);
  if (n > (req.path.startsWith('/api') ? 400 : 1000)) return res.status(429).json({ error: 'Too many requests, slow down' });
  next();
});
// 4) CSRF guard: state-changing API calls must come from our own app (custom header a cross-site form cannot send)
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD'].includes(req.method) || req.path === '/pms/event') return next();
  if (req.headers['x-requested-with'] !== 'hotel-app') return res.status(403).json({ error: 'Blocked request' });
  next();
});

// ---------- helpers ----------
if (!getSetting('jwt_secret')) setSetting('jwt_secret', crypto.randomBytes(32).toString('hex'));
if (!getSetting('pms_api_key')) setSetting('pms_api_key', crypto.randomBytes(20).toString('hex'));
const SECRET = process.env.JWT_SECRET || getSetting('jwt_secret');

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
const fail = (res, code, msg) => res.status(code).json({ error: msg });
const wrap = fn => (req, res) => { try { fn(req, res); } catch (e) { if (e.status) return fail(res, e.status, e.message); console.error(e); fail(res, 500, e.message); } };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const num = (v, name = 'value') => { const n = Number(v); if (!Number.isFinite(n)) throw bad(`${name} must be a number`); return n; };
const posNum = (v, name) => { const n = num(v, name); if (n <= 0) throw bad(`${name} must be greater than 0`); return n; };
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

function parseCookies(h = '') { return Object.fromEntries(h.split(';').map(c => c.trim().split('=').map(decodeURIComponent)).filter(a => a[0])); }
function auth(req, res, next) {
  const tok = parseCookies(req.headers.cookie).tok;
  try {
    const p = jwt.verify(tok, SECRET);
    const u = db.prepare('SELECT id,name,email,role,active,property_ids FROM users WHERE id=?').get(p.id);
    if (!u || !u.active) throw 0;
    req.user = u;
    // properties this user may work in, and the one currently selected (x-property header; "all" = every allowed one)
    req.allowed = allowedProps(u);
    const h = String(req.headers['x-property'] || req.query.prop || '');
    req.pids = (/^\d+$/.test(h) && req.allowed.includes(+h)) ? [+h] : req.allowed;
    req.pid = req.pids.length === 1 ? req.pids[0] : null;
    next();
  } catch { fail(res, 401, 'Please sign in'); }
}
const ROLES = ['admin', 'manager', 'accounts', 'housekeeping'];
const need = (...roles) => (req, res, next) =>
  (req.user.role === 'admin' || roles.includes(req.user.role)) ? next() : fail(res, 403, 'You do not have permission for this');

function log(user, type, o = {}) {
  db.prepare('INSERT INTO movements(user_id,type,item_id,asset_id,from_loc,to_loc,qty,note) VALUES (?,?,?,?,?,?,?,?)')
    .run(user, type, o.item_id ?? null, o.asset_id ?? null, o.from_loc ?? null, o.to_loc ?? null, o.qty ?? null, o.note ?? null);
}
function ensureStock(item_id, location_id) {
  db.prepare('INSERT OR IGNORE INTO stock(item_id,location_id,qty,par) VALUES (?,?,0,0)').run(item_id, location_id);
}
function changeStock(item_id, location_id, delta) {
  const item = db.prepare('SELECT kind FROM items WHERE id=?').get(item_id);
  if (!item) throw bad('Item not found', 404);
  if (item.kind !== 'consumable') throw bad('This is an individually tagged asset item, not a counted stock item');
  if (!db.prepare('SELECT 1 FROM locations WHERE id=?').get(location_id)) throw bad('Location not found', 404);
  ensureStock(item_id, location_id);
  const cur = db.prepare('SELECT qty FROM stock WHERE item_id=? AND location_id=?').get(item_id, location_id).qty;
  if (cur + delta < -1e-9) throw bad(`Not enough stock (have ${cur}, need ${-delta})`);
  db.prepare('UPDATE stock SET qty=qty+? WHERE item_id=? AND location_id=?').run(delta, item_id, location_id);
}
const mainStore = pid => {
  if (!pid) return null;
  const p = db.prepare('SELECT main_store_id FROM properties WHERE id=?').get(pid);
  if (p && p.main_store_id && db.prepare('SELECT 1 FROM locations WHERE id=? AND property_id=? AND active=1').get(p.main_store_id, pid)) return p.main_store_id;
  const s = db.prepare("SELECT id FROM locations WHERE type='store' AND active=1 AND property_id=? ORDER BY id LIMIT 1").get(pid);
  return s ? s.id : null;
};
// ----- property scoping -----
function allowedProps(u) {
  const all = db.prepare('SELECT id FROM properties WHERE active=1 ORDER BY id').all().map(r => r.id);
  if (u.role === 'admin' || !u.property_ids) return all;
  const mine = String(u.property_ids).split(',').map(Number);
  return all.filter(id => mine.includes(id));
}
const PL = req => req.pids.map(Number).filter(Number.isInteger).join(',') || '0';   // SQL list of property ids in scope
const canProp = (req, id) => req.allowed.includes(Number(id));
const needProp = (req, id) => { if (!canProp(req, id)) throw bad('Not found', 404); return Number(id); };
const pickProp = (req, v) => { const id = Number(v || req.pid); if (!id) throw bad('Choose a property'); return needProp(req, id); };
const locOf = (req, id) => { const l = db.prepare('SELECT * FROM locations WHERE id=?').get(id); if (!l || !canProp(req, l.property_id)) throw bad('Location not found', 404); return l; };
const assetAccess = (req, a) => { const l = a.location_id ? db.prepare('SELECT property_id FROM locations WHERE id=?').get(a.location_id) : null; if (l && !canProp(req, l.property_id)) throw bad('Not found', 404); };
const normProps = v => { const a = (Array.isArray(v) ? v : String(v || '').split(',')).map(Number).filter(Number.isInteger); return a.length ? a.join(',') : null; };
const tx = fn => db.transaction(fn)();

// ---------- auth ----------
const attempts = new Map();
app.post('/api/login', wrap((req, res) => {
  const key = req.ip; const a = attempts.get(key) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) throw bad('Too many attempts, try again in 15 minutes', 429);
  const { email, password } = req.body || {};
  const ek = 'e:' + String(email || '').toLowerCase(); const ea = attempts.get(ek) || { n: 0, t: Date.now() };
  if (Date.now() - ea.t > 15 * 60e3) { ea.n = 0; ea.t = Date.now(); }
  if (ea.n >= 8) throw bad('Too many attempts for this account, try again in 15 minutes', 429);
  const u = db.prepare('SELECT * FROM users WHERE lower(email)=lower(?) AND active=1').get(email || '');
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) { a.n++; attempts.set(key, a); ea.n++; attempts.set(ek, ea); throw bad('Wrong email or password', 401); }
  attempts.delete(key); attempts.delete(ek);
  const tok = jwt.sign({ id: u.id }, SECRET, { expiresIn: '14d' });
  res.cookie('tok', tok, { httpOnly: true, sameSite: 'lax', secure: req.secure || process.env.NODE_ENV === 'production', maxAge: 14 * 864e5 });
  res.json({ id: u.id, name: u.name, email: u.email, role: u.role });
}));
app.post('/api/logout', (req, res) => { res.clearCookie('tok'); res.json({ ok: true }); });

// PMS webhook (own auth: API key) — registered before the auth wall
app.post('/api/pms/event', wrap((req, res) => {
  const key = req.headers['x-api-key'] || '';
  const real = getSetting('pms_api_key');
  if (key.length !== real.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(real))) throw bad('Invalid API key', 401);
  const e = req.body || {};
  const events = Array.isArray(e) ? e : [e];
  const out = events.map(ev => applyPmsEvent(ev));
  res.json({ ok: true, results: out });
}));
function applyPmsEvent(ev) {
  const room = String(ev.room || '');
  const prop = ev.property ? db.prepare('SELECT id FROM properties WHERE code=? OR name=?').get(String(ev.property), String(ev.property)) : null;
  if (ev.property && !prop) return { ok: false, error: `Unknown property "${ev.property}"` };
  const loc = db.prepare('SELECT * FROM locations WHERE (code=? OR pms_room_id=? OR name=?)' + (prop ? ' AND property_id=?' : '')).get(room, room, room, ...(prop ? [prop.id] : []));
  if (!loc) return { ok: false, error: `Unknown room "${room}"` };
  const type = ev.event;
  if (type === 'room_status') {
    if (!['clean', 'dirty', 'inspected', 'maintenance'].includes(ev.status)) return { ok: false, error: 'bad status' };
    db.prepare('UPDATE locations SET status=? WHERE id=?').run(ev.status, loc.id);
    return { ok: true };
  }
  if (['booking', 'checkin', 'cancel'].includes(type)) {
    if (!ev.uid) return { ok: false, error: 'uid required' };
    if (type === 'cancel') {
      db.prepare("UPDATE bookings SET status='cancelled' WHERE source='pms' AND uid=?").run(String(ev.uid));
      return { ok: true };
    }
    if (!isDate(ev.checkin) || !isDate(ev.checkout)) return { ok: false, error: 'checkin/checkout must be YYYY-MM-DD' };
    db.prepare(`INSERT INTO bookings(location_id,source,uid,guest,checkin,checkout,status) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(source,uid) DO UPDATE SET location_id=excluded.location_id,guest=excluded.guest,checkin=excluded.checkin,checkout=excluded.checkout,status=excluded.status`)
      .run(loc.id, 'pms', String(ev.uid), ev.guest || null, ev.checkin, ev.checkout, type === 'checkin' ? 'in_house' : 'confirmed');
    return { ok: true };
  }
  if (type === 'checkout') {
    if (ev.uid) db.prepare("UPDATE bookings SET status='checked_out' WHERE source='pms' AND uid=?").run(String(ev.uid));
    db.prepare("UPDATE locations SET status='dirty' WHERE id=?").run(loc.id);
    notify('cleaning', loc.property_id, { title: 'Room needs cleaning', body: `${loc.name} has checked out`, url: '#/rooms', tag: 'clean-' + loc.id });
    return { ok: true };
  }
  return { ok: false, error: `Unknown event "${type}"` };
}

// ---------- uploads (auth-protected) ----------
const UP = path.join(DATA_DIR, 'uploads');
const upload = multer({
  storage: multer.diskStorage({
    destination: UP,
    filename: (req, f, cb) => cb(null, crypto.randomBytes(16).toString('hex') + ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[f.mimetype] || '.bin'))
  }),
  limits: { fileSize: 12 * 1024 * 1024, files: 8 },
  fileFilter: (req, f, cb) => ['image/jpeg', 'image/png', 'image/webp'].includes(f.mimetype) ? cb(null, true) : cb(bad('Only JPG, PNG or WebP photos are allowed'))
});
app.get('/uploads/:name', auth, (req, res) => {
  const n = path.basename(req.params.name);
  const f = path.join(UP, n);
  if (!fs.existsSync(f)) return res.sendStatus(404);
  res.sendFile(f);
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', auth);

const propRows = req => db.prepare(`SELECT id,code,name,city FROM properties WHERE id IN (${req.allowed.map(Number).join(',') || '0'}) ORDER BY name`).all();
app.get('/api/me', (req, res) => res.json({ id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role, properties: propRows(req), property_id: req.pid }));

// ---------- users ----------
app.get('/api/users', need(), wrap((req, res) => res.json(db.prepare('SELECT id,name,email,role,active,property_ids FROM users ORDER BY name').all())));
app.post('/api/users', need(), wrap((req, res) => {
  const { name, email, password, role, property_ids } = req.body || {};
  if (!name || !email || !password || password.length < 8) throw bad('Name, email and a password of 8+ characters are required');
  if (!ROLES.includes(role)) throw bad('Invalid role');
  try { const r = db.prepare('INSERT INTO users(name,email,password_hash,role,property_ids) VALUES (?,?,?,?,?)').run(name, email.trim(), bcrypt.hashSync(password, 10), role, normProps(property_ids)); res.json({ id: r.lastInsertRowid }); }
  catch (e) { throw bad('That email is already used'); }
}));
app.put('/api/users/:id', need(), wrap((req, res) => {
  const { name, role, active, password, property_ids } = req.body || {};
  if (role && !ROLES.includes(role)) throw bad('Invalid role');
  if (Number(req.params.id) === req.user.id && (active === 0 || (role && role !== 'admin'))) throw bad('You cannot demote or deactivate yourself');
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id); if (!u) throw bad('Not found', 404);
  db.prepare('UPDATE users SET name=?,role=?,active=?,property_ids=? WHERE id=?').run(name ?? u.name, role ?? u.role, active ?? u.active, property_ids === undefined ? u.property_ids : normProps(property_ids), u.id);
  if (password) { if (password.length < 8) throw bad('Password must be 8+ characters'); db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password, 10), u.id); }
  res.json({ ok: true });
}));
app.post('/api/me/password', wrap((req, res) => {
  const { current, next } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(current || '', u.password_hash)) throw bad('Current password is wrong');
  if (!next || next.length < 8) throw bad('New password must be 8+ characters');
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(next, 10), u.id);
  res.json({ ok: true });
}));

// ---------- locations / rooms ----------
const OCC_SQL = `(SELECT b.guest FROM bookings b WHERE b.location_id=l.id AND b.status NOT IN ('cancelled','checked_out','blocked') AND b.checkin<=? AND b.checkout>? ORDER BY b.checkin LIMIT 1)`;
app.get('/api/locations', wrap((req, res) => {
  const t = today();
  const rows = db.prepare(`SELECT l.*, ${OCC_SQL} AS guest,
    EXISTS(SELECT 1 FROM bookings b WHERE b.location_id=l.id AND b.status NOT IN ('cancelled','checked_out') AND b.checkin<=? AND b.checkout>?) AS occupied,
    (SELECT COUNT(*) FROM assets a WHERE a.location_id=l.id AND a.condition<>'retired') AS asset_count,
    (SELECT code FROM properties WHERE id=l.property_id) AS property_code
    FROM locations l WHERE l.active=1 AND l.property_id IN (${PL(req)}) ORDER BY l.type, l.floor, l.name`).all(t, t, t, t);
  res.json(rows);
}));
function newLocCode(type) { const p = type === 'room' ? 'R' : 'L'; let i = db.prepare('SELECT COUNT(*) c FROM locations').get().c + 1; while (db.prepare('SELECT 1 FROM locations WHERE code=?').get(`${p}-${i}`)) i++; return `${p}-${i}`; }
app.post('/api/locations', need('manager'), wrap((req, res) => {
  const b = req.body || {}; if (!b.name) throw bad('Name is required');
  const prop = pickProp(req, b.property_id);
  if (!['room', 'store', 'other'].includes(b.type || 'room')) throw bad('Invalid type');
  const code = (b.code || '').trim() || newLocCode(b.type || 'room');
  try {
    const r = db.prepare('INSERT INTO locations(code,name,type,room_type,floor,ical_url,pms_room_id,property_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(code, b.name, b.type || 'room', b.room_type || null, b.floor || null, b.ical_url || null, b.pms_room_id || null, prop);
    res.json({ id: r.lastInsertRowid, code });
  } catch { throw bad('That code is already used'); }
}));
app.put('/api/locations/:id', need('manager'), wrap((req, res) => {
  const l = locOf(req, req.params.id);
  const b = { ...l, ...req.body }; b.property_id = needProp(req, b.property_id);
  if (b.ical_url && !/^https:\/\//i.test(b.ical_url)) throw bad('Calendar link must start with https://');
  if (!['clean', 'dirty', 'inspected', 'maintenance'].includes(b.status)) throw bad('Invalid status');
  try {
    db.prepare('UPDATE locations SET name=?,code=?,type=?,room_type=?,floor=?,ical_url=?,pms_room_id=?,status=?,active=?,property_id=? WHERE id=?')
      .run(b.name, b.code, b.type, b.room_type, b.floor, b.ical_url || null, b.pms_room_id || null, b.status, b.active, b.property_id, l.id);
  } catch { throw bad('That code is already used'); }
  res.json({ ok: true });
}));
app.post('/api/locations/:id/status', wrap((req, res) => {
  const s = req.body.status; if (!['clean', 'dirty', 'inspected', 'maintenance'].includes(s)) throw bad('Invalid status');
  locOf(req, req.params.id);
  db.prepare('UPDATE locations SET status=? WHERE id=?').run(s, req.params.id); res.json({ ok: true });
}));
app.get('/api/locations/:id', wrap((req, res) => {
  const l = locOf(req, req.params.id);
  const stock = db.prepare(`SELECT s.item_id,s.qty,s.par,i.name,i.unit,i.sku,i.category FROM stock s JOIN items i ON i.id=s.item_id WHERE s.location_id=? AND (s.qty<>0 OR s.par<>0) ORDER BY i.category,i.name`).all(l.id);
  const assets = db.prepare(`SELECT a.id,a.tag,a.condition,a.serial,i.name FROM assets a JOIN items i ON i.id=a.item_id WHERE a.location_id=? AND a.condition<>'retired' ORDER BY i.name`).all(l.id);
  const bookings = db.prepare(`SELECT * FROM bookings WHERE location_id=? AND checkout>=? AND status<>'cancelled' ORDER BY checkin LIMIT 20`).all(l.id, today());
  const tpl = l.room_type ? db.prepare(`SELECT t.item_id,t.qty,i.name,i.kind FROM room_templates t JOIN items i ON i.id=t.item_id WHERE t.room_type=?`).all(l.room_type) : [];
  res.json({ ...l, stock, assets, bookings, template: tpl });
}));

// ---------- items ----------
app.get('/api/items', wrap((req, res) => {
  const { q, kind } = req.query;
  let sql = `SELECT i.*, s.name AS supplier,
    COALESCE((SELECT SUM(s2.qty) FROM stock s2 JOIN locations l2 ON l2.id=s2.location_id WHERE s2.item_id=i.id AND l2.property_id IN (${PL(req)})),0) AS total_qty,
    (SELECT COUNT(*) FROM assets a2 JOIN locations l3 ON l3.id=a2.location_id WHERE a2.item_id=i.id AND a2.condition<>'retired' AND l3.property_id IN (${PL(req)})) AS asset_count
    FROM items i LEFT JOIN suppliers s ON s.id=i.supplier_id WHERE i.active=1`;
  const p = [];
  if (kind) { sql += ' AND i.kind=?'; p.push(kind); }
  if (q) { sql += ' AND (i.name LIKE ? OR i.sku LIKE ? OR i.barcode LIKE ?)'; p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  res.json(db.prepare(sql + ' ORDER BY i.category,i.name').all(...p));
}));
app.post('/api/items', need('manager'), wrap((req, res) => {
  const b = req.body || {}; if (!b.name) throw bad('Name is required');
  if (!['consumable', 'asset'].includes(b.kind || 'consumable')) throw bad('Invalid kind');
  try {
    const r = tx(() => {
      const r = db.prepare('INSERT INTO items(sku,name,category,kind,unit,barcode,cost,supplier_id,reorder_level) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(b.sku || null, b.name, b.category || null, b.kind || 'consumable', b.unit || 'pcs', b.barcode || null, Number(b.cost) || 0, b.supplier_id || null, Number(b.reorder_level) || 0);
      const id = r.lastInsertRowid;
      if (!b.barcode) db.prepare('UPDATE items SET barcode=? WHERE id=?').run('I' + String(id).padStart(5, '0'), id);
      return id;
    });
    res.json({ id: r });
  } catch (e) { throw bad('SKU or barcode already used'); }
}));
app.put('/api/items/:id', need('manager'), wrap((req, res) => {
  const i = db.prepare('SELECT * FROM items WHERE id=?').get(req.params.id); if (!i) throw bad('Not found', 404);
  const b = { ...i, ...req.body };
  try {
    db.prepare('UPDATE items SET sku=?,name=?,category=?,unit=?,barcode=?,cost=?,supplier_id=?,reorder_level=?,active=? WHERE id=?')
      .run(b.sku || null, b.name, b.category, b.unit, b.barcode, Number(b.cost) || 0, b.supplier_id || null, Number(b.reorder_level) || 0, b.active, i.id);
  } catch { throw bad('SKU or barcode already used'); }
  res.json({ ok: true });
}));
app.get('/api/items/:id', wrap((req, res) => {
  const i = db.prepare('SELECT * FROM items WHERE id=?').get(req.params.id); if (!i) throw bad('Not found', 404);
  const stock = db.prepare(`SELECT s.*,l.name AS location,l.type FROM stock s JOIN locations l ON l.id=s.location_id WHERE s.item_id=? AND (s.qty<>0 OR s.par<>0) AND l.property_id IN (${PL(req)}) ORDER BY l.name`).all(i.id);
  const assets = db.prepare(`SELECT a.*,l.name AS location FROM assets a JOIN locations l ON l.id=a.location_id WHERE a.item_id=? AND l.property_id IN (${PL(req)}) ORDER BY a.tag`).all(i.id);
  const history = db.prepare(`SELECT m.*,u.name AS user,f.name AS from_name,t.name AS to_name FROM movements m LEFT JOIN users u ON u.id=m.user_id
    LEFT JOIN locations f ON f.id=m.from_loc LEFT JOIN locations t ON t.id=m.to_loc WHERE m.item_id=? ORDER BY m.id DESC LIMIT 50`).all(i.id);
  res.json({ ...i, stock, assets, history });
}));

// ---------- stock operations ----------
app.post('/api/stock/receive', need('manager', 'housekeeping'), wrap((req, res) => {
  const { item_id, location_id, qty, note } = req.body; const q = posNum(qty, 'Quantity'); locOf(req, location_id);
  tx(() => { changeStock(item_id, location_id, q); log(req.user.id, 'receive', { item_id, to_loc: location_id, qty: q, note }); });
  res.json({ ok: true });
}));
app.post('/api/stock/issue', need('manager', 'housekeeping'), wrap((req, res) => {
  const { item_id, location_id, qty, note } = req.body; const q = posNum(qty, 'Quantity'); locOf(req, location_id);
  tx(() => { changeStock(item_id, location_id, -q); log(req.user.id, 'issue', { item_id, from_loc: location_id, qty: q, note: note || 'Issued / used / written off' }); });
  res.json({ ok: true });
}));
app.post('/api/stock/consume', wrap((req, res) => {
  const { item_id, location_id, qty, note } = req.body; const q = posNum(qty, 'Quantity'); locOf(req, location_id);
  tx(() => { changeStock(item_id, location_id, -q); log(req.user.id, 'consume', { item_id, from_loc: location_id, qty: q, note }); });
  res.json({ ok: true });
}));
app.post('/api/stock/transfer', wrap((req, res) => {
  const { item_id, from_loc, to_loc, qty, note } = req.body; const q = posNum(qty, 'Quantity');
  if (from_loc === to_loc) throw bad('Choose two different locations'); locOf(req, from_loc); locOf(req, to_loc);
  tx(() => { changeStock(item_id, from_loc, -q); changeStock(item_id, to_loc, q); log(req.user.id, 'transfer', { item_id, from_loc, to_loc, qty: q, note }); });
  res.json({ ok: true });
}));
app.post('/api/stock/adjust', need('manager'), wrap((req, res) => {
  const { item_id, location_id, new_qty, note } = req.body; const n = num(new_qty, 'Counted quantity');
  if (n < 0) throw bad('Quantity cannot be negative'); if (!note) throw bad('Please give a reason'); locOf(req, location_id);
  tx(() => {
    ensureStock(item_id, location_id);
    const cur = db.prepare('SELECT qty FROM stock WHERE item_id=? AND location_id=?').get(item_id, location_id).qty;
    changeStock(item_id, location_id, n - cur);
    log(req.user.id, 'adjust', { item_id, to_loc: location_id, qty: n - cur, note });
  });
  res.json({ ok: true });
}));
app.put('/api/stock/par', need('manager'), wrap((req, res) => {
  const { item_id, location_id, par } = req.body; const p = num(par, 'Par'); if (p < 0) throw bad('Par cannot be negative'); locOf(req, location_id);
  ensureStock(item_id, location_id);
  db.prepare('UPDATE stock SET par=? WHERE item_id=? AND location_id=?').run(p, item_id, location_id);
  res.json({ ok: true });
}));
app.get('/api/movements', wrap((req, res) => {
  const lim = Math.min(Number(req.query.limit) || 100, 500);
  res.json(db.prepare(`SELECT m.*,u.name AS user,i.name AS item,a.tag,f.name AS from_name,t.name AS to_name FROM movements m
    LEFT JOIN users u ON u.id=m.user_id LEFT JOIN items i ON i.id=m.item_id LEFT JOIN assets a ON a.id=m.asset_id
    LEFT JOIN locations f ON f.id=m.from_loc LEFT JOIN locations t ON t.id=m.to_loc
    WHERE f.property_id IN (${PL(req)}) OR t.property_id IN (${PL(req)}) ORDER BY m.id DESC LIMIT ?`).all(lim));
}));

// Housekeeping restock: what each room is short of versus par, filled from main store
function restockNeeds(locationId, pl) {
  const rows = db.prepare(`SELECT s.location_id,l.property_id,l.name AS room,l.code,s.item_id,i.name AS item,i.unit,s.par,s.qty,(s.par-s.qty) AS need
    FROM stock s JOIN locations l ON l.id=s.location_id JOIN items i ON i.id=s.item_id
    WHERE l.type='room' AND l.active=1 AND l.property_id IN (${pl}) AND s.par>s.qty ${locationId ? 'AND s.location_id=?' : ''} ORDER BY l.name,i.name`).all(...(locationId ? [locationId] : []));
  return rows;
}
app.get('/api/restock', wrap((req, res) => res.json({ store_id: mainStore(req.pid), needs: restockNeeds(req.query.location_id, PL(req)) })));
app.post('/api/restock/fulfil', wrap((req, res) => {
  if (req.body.location_id) locOf(req, req.body.location_id);
  const needs = restockNeeds(req.body.location_id, PL(req)); const short = [];
  if (!needs.length) return res.json({ ok: true, short });
  if (needs.some(n => !mainStore(n.property_id))) throw bad('Create a store location for each property first');
  tx(() => {
    for (const n of needs) {
      const store = mainStore(n.property_id);
      const have = db.prepare('SELECT qty FROM stock WHERE item_id=? AND location_id=?').get(n.item_id, store)?.qty || 0;
      const give = Math.min(have, n.need);
      if (give > 0) { changeStock(n.item_id, store, -give); changeStock(n.item_id, n.location_id, give); log(req.user.id, 'transfer', { item_id: n.item_id, from_loc: store, to_loc: n.location_id, qty: give, note: 'Restock to par' }); }
      if (give < n.need) short.push({ room: n.room, item: n.item, short_by: n.need - give });
    }
  });
  res.json({ ok: true, short });
}));

// ---------- assets ----------
app.get('/api/assets', wrap((req, res) => {
  const { q, location_id, condition, item_id } = req.query;
  let sql = `SELECT a.*,i.name,i.category,l.name AS location,l.code AS location_code FROM assets a JOIN items i ON i.id=a.item_id LEFT JOIN locations l ON l.id=a.location_id WHERE l.property_id IN (${PL(req)})`;
  const p = [];
  if (q) { sql += ' AND (a.tag LIKE ? OR i.name LIKE ? OR a.serial LIKE ?)'; p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (location_id) { sql += ' AND a.location_id=?'; p.push(location_id); }
  if (condition) { sql += ' AND a.condition=?'; p.push(condition); }
  if (item_id) { sql += ' AND a.item_id=?'; p.push(item_id); }
  res.json(db.prepare(sql + ' ORDER BY a.tag LIMIT 1000').all(...p));
}));
app.post('/api/assets', need('manager'), wrap((req, res) => {
  const b = req.body || {}; const count = Math.min(Math.max(parseInt(b.count) || 1, 1), 200);
  const item = db.prepare("SELECT * FROM items WHERE id=? AND kind='asset'").get(b.item_id);
  if (!item) throw bad('Choose an item of type "asset"');
  if (count > 1 && b.serial) throw bad('Serial number can only be set when adding one unit');
  const locId = b.location_id ? locOf(req, b.location_id).id : mainStore(req.pid);
  if (!locId) throw bad('Choose a location (or create a store for this property first)');
  const ids = tx(() => {
    const out = [];
    for (let k = 0; k < count; k++) {
      const r = db.prepare('INSERT INTO assets(tag,item_id,serial,location_id,condition,purchase_date,cost,warranty_until,notes) VALUES (?,?,?,?,?,?,?,?,?)')
        .run('TMP' + crypto.randomBytes(4).toString('hex'), item.id, b.serial || null, locId, 'good', b.purchase_date || null, b.cost ?? item.cost, b.warranty_until || null, b.notes || null);
      const id = r.lastInsertRowid;
      db.prepare('UPDATE assets SET tag=? WHERE id=?').run('A' + String(id).padStart(5, '0'), id);
      log(req.user.id, 'asset_move', { asset_id: id, item_id: item.id, to_loc: locId, note: 'Registered' });
      out.push(id);
    }
    return out;
  });
  res.json({ ids });
}));
app.get('/api/assets/:id', wrap((req, res) => {
  const a = db.prepare(`SELECT a.*,i.name,i.category,l.name AS location FROM assets a JOIN items i ON i.id=a.item_id LEFT JOIN locations l ON l.id=a.location_id WHERE a.id=?`).get(req.params.id);
  if (!a) throw bad('Not found', 404); assetAccess(req, a);
  const history = db.prepare(`SELECT m.*,u.name AS user,f.name AS from_name,t.name AS to_name FROM movements m LEFT JOIN users u ON u.id=m.user_id
    LEFT JOIN locations f ON f.id=m.from_loc LEFT JOIN locations t ON t.id=m.to_loc WHERE m.asset_id=? ORDER BY m.id DESC LIMIT 100`).all(a.id);
  res.json({ ...a, history });
}));
app.put('/api/assets/:id', need('manager'), wrap((req, res) => {
  const a = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id); if (!a) throw bad('Not found', 404); assetAccess(req, a);
  const b = { ...a, ...req.body };
  db.prepare('UPDATE assets SET serial=?,purchase_date=?,cost=?,warranty_until=?,notes=? WHERE id=?').run(b.serial, b.purchase_date, b.cost, b.warranty_until, b.notes, a.id);
  res.json({ ok: true });
}));
app.post('/api/assets/:id/move', wrap((req, res) => {
  const a = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id); if (!a) throw bad('Not found', 404); assetAccess(req, a);
  const to = req.body.to_loc; if (!to) throw bad('Choose a destination'); locOf(req, to);
  tx(() => {
    db.prepare("UPDATE assets SET location_id=?, condition=CASE WHEN condition='missing' THEN 'good' ELSE condition END WHERE id=?").run(to, a.id);
    log(req.user.id, 'asset_move', { asset_id: a.id, item_id: a.item_id, from_loc: a.location_id, to_loc: to, note: req.body.note });
  });
  res.json({ ok: true });
}));
app.post('/api/assets/:id/condition', wrap((req, res) => {
  const a = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id); if (!a) throw bad('Not found', 404); assetAccess(req, a);
  const c = req.body.condition; if (!['good', 'needs_repair', 'under_repair', 'retired', 'missing'].includes(c)) throw bad('Invalid condition');
  if (c === 'retired' && !['admin', 'manager'].includes(req.user.role)) throw bad('Only a manager can retire an asset', 403);
  tx(() => { db.prepare('UPDATE assets SET condition=? WHERE id=?').run(c, a.id); log(req.user.id, 'asset_condition', { asset_id: a.id, item_id: a.item_id, from_loc: a.location_id, note: `${a.condition} → ${c}. ${req.body.note || ''}`.trim() }); });
  res.json({ ok: true });
}));

// ---------- room templates ----------
app.get('/api/templates', wrap((req, res) => {
  const rows = db.prepare('SELECT t.room_type,t.item_id,t.qty,i.name,i.kind FROM room_templates t JOIN items i ON i.id=t.item_id ORDER BY t.room_type,i.name').all();
  const types = db.prepare("SELECT DISTINCT room_type FROM locations WHERE room_type IS NOT NULL AND room_type<>''").all().map(r => r.room_type);
  res.json({ types, rows });
}));
app.put('/api/templates/:type', need('manager'), wrap((req, res) => {
  const lines = req.body.lines || [];
  tx(() => {
    db.prepare('DELETE FROM room_templates WHERE room_type=?').run(req.params.type);
    for (const l of lines) if (Number(l.qty) > 0) db.prepare('INSERT OR REPLACE INTO room_templates(room_type,item_id,qty) VALUES (?,?,?)').run(req.params.type, l.item_id, Number(l.qty));
  });
  res.json({ ok: true });
}));

// ---------- room audit by scan ----------
// body: { location_id, tags: [asset tags scanned], counts: {item_id: counted_qty}, apply: bool }
app.post('/api/audit', wrap((req, res) => {
  const { location_id, tags = [], counts = {}, apply } = req.body || {};
  if (!location_id) throw bad('Choose a room', 404); const loc = locOf(req, location_id);
  const scanned = [...new Set(tags)].map(t => db.prepare('SELECT a.*,i.name FROM assets a JOIN items i ON i.id=a.item_id WHERE a.tag=?').get(t)).filter(Boolean);
  const unknownTags = [...new Set(tags)].filter(t => !db.prepare('SELECT 1 FROM assets WHERE tag=?').get(t));
  const scannedIds = new Set(scanned.map(a => a.id));
  const inSystem = db.prepare("SELECT a.*,i.name FROM assets a JOIN items i ON i.id=a.item_id WHERE a.location_id=? AND a.condition NOT IN ('retired')").all(loc.id);
  const missing = inSystem.filter(a => !scannedIds.has(a.id)).map(a => ({ id: a.id, tag: a.tag, name: a.name }));
  const extra = scanned.filter(a => a.location_id !== loc.id).map(a => ({ id: a.id, tag: a.tag, name: a.name, was_in: db.prepare('SELECT name FROM locations WHERE id=?').get(a.location_id)?.name || 'unknown' }));
  const damaged = scanned.filter(a => a.condition === 'needs_repair' || a.condition === 'under_repair').map(a => ({ id: a.id, tag: a.tag, name: a.name, condition: a.condition }));
  // template check for asset kinds: expected count per item vs scanned-in-room count
  const shortfalls = [];
  if (loc.room_type) {
    const tpl = db.prepare("SELECT t.item_id,t.qty,i.name,i.kind FROM room_templates t JOIN items i ON i.id=t.item_id WHERE t.room_type=? AND i.kind='asset'").all(loc.room_type);
    for (const t of tpl) {
      const have = scanned.filter(a => a.item_id === t.item_id).length;
      if (have < t.qty) shortfalls.push({ item_id: t.item_id, name: t.name, expected: t.qty, found: have });
    }
  }
  const variances = [];
  for (const [item_id, counted] of Object.entries(counts)) {
    const c = num(counted, 'Counted quantity'); if (c < 0) throw bad('Counts cannot be negative');
    const sys = db.prepare('SELECT qty FROM stock WHERE item_id=? AND location_id=?').get(item_id, loc.id)?.qty || 0;
    const it = db.prepare('SELECT name,unit FROM items WHERE id=?').get(item_id);
    if (it && c !== sys) variances.push({ item_id: Number(item_id), name: it.name, system: sys, counted: c });
  }
  const result = { missing, extra, damaged, shortfalls, variances, unknown_tags: unknownTags, scanned: scanned.length, applied: !!apply };
  if (apply) tx(() => {
    for (const a of extra) { db.prepare('UPDATE assets SET location_id=? WHERE id=?').run(loc.id, a.id); log(req.user.id, 'asset_move', { asset_id: a.id, to_loc: loc.id, note: 'Found during room audit' }); }
    for (const a of scanned) if (a.condition === 'missing') db.prepare("UPDATE assets SET condition='good' WHERE id=?").run(a.id);
    for (const a of missing) { db.prepare("UPDATE assets SET condition='missing' WHERE id=?").run(a.id); log(req.user.id, 'asset_condition', { asset_id: a.id, from_loc: loc.id, note: 'Not found during room audit' }); }
    for (const v of variances) { changeStock(v.item_id, loc.id, v.counted - v.system); log(req.user.id, 'adjust', { item_id: v.item_id, to_loc: loc.id, qty: v.counted - v.system, note: 'Room audit count' }); }
    db.prepare('INSERT INTO audits(user_id,location_id,result) VALUES (?,?,?)').run(req.user.id, loc.id, JSON.stringify(result));
  });
  res.json(result);
}));
app.get('/api/audits', wrap((req, res) => {
  const rows = db.prepare('SELECT a.id,a.ts,a.result,u.name AS user,l.name AS location FROM audits a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN locations l ON l.id=a.location_id WHERE l.property_id IN (' + PL(req) + ') ORDER BY a.id DESC LIMIT 100').all();
  res.json(rows.map(r => ({ ...r, result: JSON.parse(r.result) })));
}));

// ---------- suppliers & purchase orders ----------
app.get('/api/suppliers', wrap((req, res) => res.json(db.prepare('SELECT * FROM suppliers ORDER BY name').all())));
app.post('/api/suppliers', need('manager', 'accounts'), wrap((req, res) => {
  const b = req.body || {}; if (!b.name) throw bad('Name is required');
  res.json({ id: db.prepare('INSERT INTO suppliers(name,phone,email,notes) VALUES (?,?,?,?)').run(b.name, b.phone || null, b.email || null, b.notes || null).lastInsertRowid });
}));
app.get('/api/pos', wrap((req, res) => {
  const pos = db.prepare(`SELECT p.*,s.name AS supplier,(SELECT SUM(qty*unit_cost) FROM po_lines WHERE po_id=p.id) AS total FROM purchase_orders p LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.property_id IN (${PL(req)}) ORDER BY p.id DESC LIMIT 200`).all();
  for (const p of pos) p.lines = db.prepare('SELECT l.*,i.name,i.unit FROM po_lines l JOIN items i ON i.id=l.item_id WHERE po_id=?').all(p.id);
  res.json(pos);
}));
app.post('/api/pos', need('manager', 'accounts'), wrap((req, res) => {
  const { supplier_id, lines = [], note } = req.body || {};
  if (!lines.length) throw bad('Add at least one line');
  const prop = pickProp(req, req.body.property_id);
  const id = tx(() => {
    const id = db.prepare('INSERT INTO purchase_orders(supplier_id,created_by,note,property_id) VALUES (?,?,?,?)').run(supplier_id || null, req.user.id, note || null, prop).lastInsertRowid;
    for (const l of lines) {
      const it = db.prepare('SELECT kind FROM items WHERE id=?').get(l.item_id); if (!it) throw bad('Item not found');
      db.prepare('INSERT INTO po_lines(po_id,item_id,qty,unit_cost) VALUES (?,?,?,?)').run(id, l.item_id, posNum(l.qty, 'Quantity'), Number(l.unit_cost) || 0);
    }
    return id;
  });
  res.json({ id });
}));
app.post('/api/pos/:id/receive', need('manager'), wrap((req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id); if (!po) throw bad('Not found', 404);
  needProp(req, po.property_id);
  if (po.status !== 'open') throw bad('This order is already closed');
  const to = req.body.location_id ? locOf(req, req.body.location_id).id : mainStore(po.property_id); if (!to) throw bad('Create a store location for this property first');
  const lines = db.prepare('SELECT l.*,i.kind,i.name FROM po_lines l JOIN items i ON i.id=l.item_id WHERE po_id=?').all(po.id);
  let expenseId = null;
  tx(() => {
    for (const l of lines) {
      if (l.kind === 'consumable') { changeStock(l.item_id, to, l.qty); log(req.user.id, 'receive', { item_id: l.item_id, to_loc: to, qty: l.qty, note: `PO #${po.id}` }); }
      else for (let k = 0; k < l.qty; k++) {
        const id = db.prepare('INSERT INTO assets(tag,item_id,location_id,cost,purchase_date) VALUES (?,?,?,?,date(\'now\'))').run('TMP' + crypto.randomBytes(4).toString('hex'), l.item_id, to, l.unit_cost).lastInsertRowid;
        db.prepare('UPDATE assets SET tag=? WHERE id=?').run('A' + String(id).padStart(5, '0'), id);
        log(req.user.id, 'asset_move', { asset_id: id, item_id: l.item_id, to_loc: to, note: `Received on PO #${po.id}` });
      }
    }
    const total = lines.reduce((s, l) => s + l.qty * l.unit_cost, 0);
    if (req.body.create_expense && total > 0) {
      const sup = db.prepare('SELECT name FROM suppliers WHERE id=?').get(po.supplier_id);
      expenseId = db.prepare('INSERT INTO expenses(date,amount,category,vendor,description,status,submitted_by,po_id,property_id) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(today(), total, 'Housekeeping supplies', sup?.name || null, `Purchase order #${po.id}`, 'pending', req.user.id, po.id, po.property_id).lastInsertRowid;
    }
    db.prepare("UPDATE purchase_orders SET status='received',received_at=datetime('now'),expense_id=? WHERE id=?").run(expenseId, po.id);
  });
  res.json({ ok: true, expense_id: expenseId });
}));
app.post('/api/pos/:id/cancel', need('manager'), wrap((req, res) => {
  const po = db.prepare('SELECT property_id FROM purchase_orders WHERE id=?').get(req.params.id); if (!po) throw bad('Not found', 404); needProp(req, po.property_id);
  db.prepare("UPDATE purchase_orders SET status='cancelled' WHERE id=? AND status='open'").run(req.params.id); res.json({ ok: true });
}));

// ---------- expenses with photos ----------
const expSelect = `SELECT e.*,su.name AS submitted_name,ap.name AS approved_name,l.name AS location,pr.name AS property FROM expenses e
  LEFT JOIN users su ON su.id=e.submitted_by LEFT JOIN users ap ON ap.id=e.approved_by LEFT JOIN locations l ON l.id=e.location_id
  LEFT JOIN properties pr ON pr.id=e.property_id`;
function expFilters(q, pl) {
  let w = ` WHERE e.property_id IN (${pl})`; const p = [];
  if (isDate(q.from)) { w += ' AND e.date>=?'; p.push(q.from); }
  if (isDate(q.to)) { w += ' AND e.date<=?'; p.push(q.to); }
  if (q.category) { w += ' AND e.category=?'; p.push(q.category); }
  if (q.status) { w += ' AND e.status=?'; p.push(q.status); }
  if (q.q) { w += ' AND (e.vendor LIKE ? OR e.description LIKE ?)'; p.push(`%${q.q}%`, `%${q.q}%`); }
  return [w, p];
}
// housekeeping staff only see their own expenses
function scope(req, w, p) { if (req.user.role === 'housekeeping') { w += ' AND e.submitted_by=?'; p.push(req.user.id); } return [w, p]; }
app.get('/api/expense-categories', wrap((req, res) => res.json(db.prepare('SELECT name FROM expense_categories ORDER BY name').all().map(r => r.name))));
app.post('/api/expense-categories', need('manager', 'accounts'), wrap((req, res) => {
  if (!req.body.name) throw bad('Name is required'); db.prepare('INSERT OR IGNORE INTO expense_categories(name) VALUES (?)').run(req.body.name.trim()); res.json({ ok: true });
}));
app.get('/api/expenses', wrap((req, res) => {
  let [w, p] = expFilters(req.query, PL(req)); [w, p] = scope(req, w, p);
  const rows = db.prepare(`${expSelect}${w} ORDER BY e.date DESC,e.id DESC LIMIT 1000`).all(...p);
  const ph = db.prepare('SELECT id,expense_id,filename FROM expense_photos WHERE expense_id IN (' + (rows.map(() => '?').join(',') || 'NULL') + ')').all(...rows.map(r => r.id));
  rows.forEach(r => r.photos = ph.filter(x => x.expense_id === r.id));
  res.json(rows);
}));
app.get('/api/expenses/summary', need('manager', 'accounts'), wrap((req, res) => {
  const [w, p] = expFilters({ ...req.query, status: undefined }, PL(req));
  const cond = w + " AND e.status<>'rejected'";
  res.json({
    total: db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM expenses e${cond}`).get(...p).t,
    by_category: db.prepare(`SELECT COALESCE(category,'Uncategorised') category,SUM(amount) total,COUNT(*) n FROM expenses e${cond} GROUP BY category ORDER BY total DESC`).all(...p),
    by_month: db.prepare(`SELECT substr(date,1,7) month,SUM(amount) total FROM expenses e${cond} GROUP BY month ORDER BY month`).all(...p),
    pending: db.prepare(`SELECT COUNT(*) n,COALESCE(SUM(amount),0) t FROM expenses WHERE status='pending' AND property_id IN (${PL(req)})`).get()
  });
}));
app.get('/api/expenses.csv', need('manager', 'accounts'), wrap((req, res) => {
  const [w, p] = expFilters(req.query, PL(req));
  const rows = db.prepare(`${expSelect}${w} ORDER BY e.date,e.id`).all(...p);
  const esc = v => { v = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const head = ['Property', 'Date', 'Amount', 'Category', 'Vendor', 'Payment', 'Description', 'Status', 'Submitted by', 'Approved by', 'Location'];
  const lines = rows.map(r => [r.property, r.date, r.amount, r.category, r.vendor, r.payment_method, r.description, r.status, r.submitted_name, r.approved_name, r.location].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename="expenses.csv"');
  res.send([head.join(','), ...lines].join('\n'));
}));
app.post('/api/expenses', upload.array('photos', 8), wrap((req, res) => {
  const b = req.body || {};
  const cleanup = () => (req.files || []).forEach(f => fs.unlink(f.path, () => { }));
  try {
    if (!isDate(b.date)) throw bad('Date is required');
    const amount = posNum(b.amount, 'Amount');
    if (!b.category) throw bad('Choose a category');
    const loc = b.location_id ? locOf(req, b.location_id) : null;
    const prop = loc ? loc.property_id : pickProp(req, b.property_id);
    const id = tx(() => {
      const id = db.prepare('INSERT INTO expenses(date,amount,category,vendor,payment_method,description,submitted_by,location_id,property_id) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(b.date, amount, b.category, b.vendor || null, b.payment_method || 'cash', b.description || null, req.user.id, loc ? loc.id : null, prop).lastInsertRowid;
      (req.files || []).forEach(f => db.prepare('INSERT INTO expense_photos(expense_id,filename) VALUES (?,?)').run(id, f.filename));
      return id;
    });
    // managers / accounts entries are auto-approved
    if (['admin', 'manager', 'accounts'].includes(req.user.role) && b.auto_approve !== '0')
      db.prepare("UPDATE expenses SET status='approved',approved_by=?,decided_at=datetime('now') WHERE id=?").run(req.user.id, id);
    res.json({ id });
  } catch (e) { cleanup(); throw e; }
}));
function loadExpense(req) {
  const e = db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id); if (!e) throw bad('Not found', 404);
  needProp(req, e.property_id);
  if (req.user.role === 'housekeeping' && e.submitted_by !== req.user.id) throw bad('Not found', 404);
  return e;
}
app.post('/api/expenses/:id/photos', upload.array('photos', 8), wrap((req, res) => {
  const e = loadExpense(req);
  if (e.status !== 'pending' && !['admin', 'manager', 'accounts'].includes(req.user.role)) throw bad('This expense is already decided', 403);
  (req.files || []).forEach(f => db.prepare('INSERT INTO expense_photos(expense_id,filename) VALUES (?,?)').run(e.id, f.filename));
  res.json({ ok: true });
}));
app.delete('/api/expenses/:id/photos/:pid', wrap((req, res) => {
  const e = loadExpense(req);
  if (e.status !== 'pending' && !['admin', 'manager', 'accounts'].includes(req.user.role)) throw bad('This expense is already decided', 403);
  const ph = db.prepare('SELECT * FROM expense_photos WHERE id=? AND expense_id=?').get(req.params.pid, e.id); if (!ph) throw bad('Not found', 404);
  db.prepare('DELETE FROM expense_photos WHERE id=?').run(ph.id); fs.unlink(path.join(UP, path.basename(ph.filename)), () => { });
  res.json({ ok: true });
}));
app.put('/api/expenses/:id', wrap((req, res) => {
  const e = loadExpense(req);
  const privileged = ['admin', 'manager', 'accounts'].includes(req.user.role);
  if (!privileged && e.status !== 'pending') throw bad('This expense is already decided', 403);
  const b = { ...e, ...req.body };
  if (!isDate(b.date)) throw bad('Date is required'); posNum(b.amount, 'Amount');
  db.prepare('UPDATE expenses SET date=?,amount=?,category=?,vendor=?,payment_method=?,description=?,location_id=?,property_id=? WHERE id=?')
    .run(b.date, Number(b.amount), b.category, b.vendor, b.payment_method, b.description, b.location_id || null, needProp(req, b.property_id), e.id);
  res.json({ ok: true });
}));
app.post('/api/expenses/:id/decision', need('manager', 'accounts'), wrap((req, res) => {
  const e = db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id); if (!e) throw bad('Not found', 404); needProp(req, e.property_id);
  const { decision, reason } = req.body || {};
  if (!['approved', 'rejected', 'pending'].includes(decision)) throw bad('Invalid decision');
  if (decision === 'rejected' && !reason) throw bad('Please give a reason for rejecting');
  if (e.submitted_by === req.user.id && decision === 'approved' && req.user.role !== 'admin' && e.status === 'pending') throw bad('Another person must approve your own expense');
  db.prepare("UPDATE expenses SET status=?,approved_by=?,decided_at=datetime('now'),reject_reason=? WHERE id=?").run(decision, req.user.id, decision === 'rejected' ? reason : null, e.id);
  res.json({ ok: true });
}));
app.delete('/api/expenses/:id', need('accounts'), wrap((req, res) => {
  const ex = db.prepare('SELECT property_id FROM expenses WHERE id=?').get(req.params.id); if (!ex) throw bad('Not found', 404); needProp(req, ex.property_id);
  const ph = db.prepare('SELECT filename FROM expense_photos WHERE expense_id=?').all(req.params.id);
  db.prepare('DELETE FROM expenses WHERE id=?').run(req.params.id);
  ph.forEach(p => fs.unlink(path.join(UP, path.basename(p.filename)), () => { }));
  res.json({ ok: true });
}));

// ---------- bookings: Airbnb iCal + PMS ----------
function unfold(t) { return t.replace(/\r?\n[ \t]/g, '').split(/\r?\n/); }
function icalDate(v) { const m = /(\d{4})(\d{2})(\d{2})/.exec(v || ''); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; }
function parseIcal(text) {
  const out = []; let cur = null;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') { if (cur && cur.uid && cur.start && cur.end) out.push(cur); cur = null; }
    else if (cur) {
      const i = line.indexOf(':'); if (i < 0) continue;
      const name = line.slice(0, i).split(';')[0].toUpperCase(); const val = line.slice(i + 1);
      if (name === 'UID') cur.uid = val; else if (name === 'DTSTART') cur.start = icalDate(val);
      else if (name === 'DTEND') cur.end = icalDate(val); else if (name === 'SUMMARY') cur.summary = val.replace(/\\,/g, ',');
    }
  }
  return out;
}
async function syncRoom(loc) {
  const r = await fetch(loc.ical_url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'hotel-stock/1.0' } });
  if (!r.ok) throw new Error(`Calendar returned ${r.status}`);
  const events = parseIcal(await r.text());
  tx(() => {
    const seen = new Set();
    for (const e of events) {
      seen.add(e.uid);
      const blocked = /not available|blocked/i.test(e.summary || '');
      db.prepare(`INSERT INTO bookings(location_id,source,uid,guest,checkin,checkout,status) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(source,uid) DO UPDATE SET location_id=excluded.location_id,guest=excluded.guest,checkin=excluded.checkin,checkout=excluded.checkout,
        status=CASE WHEN bookings.status='checked_out' THEN 'checked_out' ELSE excluded.status END`)
        .run(loc.id, 'airbnb', e.uid, blocked ? 'Blocked' : (!e.summary || /^reserved$/i.test(e.summary) ? 'Airbnb guest' : e.summary), e.start, e.end, blocked ? 'blocked' : 'confirmed');
    }
    // bookings that vanished from the feed (cancelled) and have not started
    const rows = db.prepare("SELECT id,uid FROM bookings WHERE location_id=? AND source='airbnb' AND status IN ('confirmed','blocked') AND checkin>=?").all(loc.id, today());
    rows.filter(r => !seen.has(r.uid)).forEach(r => db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(r.id));
  });
  return events.length;
}
let syncing = false;
async function syncAll() {
  if (syncing) return []; syncing = true;
  const out = [];
  try {
    for (const loc of db.prepare("SELECT * FROM locations WHERE active=1 AND ical_url IS NOT NULL AND ical_url<>''").all()) {
      try { out.push({ room: loc.name, ok: true, events: await syncRoom(loc) }); }
      catch (e) { out.push({ room: loc.name, ok: false, error: e.message }); }
    }
    setSetting('last_sync', new Date().toISOString());
  } finally { syncing = false; }
  return out;
}
app.post('/api/sync/ical', need('manager'), (req, res) => syncAll().then(r => res.json(r)).catch(e => fail(res, 500, e.message)));
setInterval(() => syncAll().catch(() => { }), 30 * 60e3).unref();
// the day a guest leaves, mark the room dirty (iCal-sourced bookings have no checkout event)
function rollRoomStatus() {
  const t = today();
  if (getSetting('last_roll') === t) return;
  db.prepare(`UPDATE locations SET status='dirty' WHERE type='room' AND status IN ('clean','inspected') AND id IN
    (SELECT location_id FROM bookings WHERE source='airbnb' AND status='confirmed' AND checkout=?)`).run(t);
  setSetting('last_roll', t);
}
setInterval(rollRoomStatus, 10 * 60e3).unref(); setTimeout(rollRoomStatus, 5000).unref();

app.get('/api/bookings', wrap((req, res) => {
  const from = isDate(req.query.from) ? req.query.from : today();
  const to = isDate(req.query.to) ? req.query.to : ymd(new Date(Date.now() + 30 * 864e5));
  res.json(db.prepare(`SELECT b.*,l.name AS room FROM bookings b JOIN locations l ON l.id=b.location_id WHERE l.property_id IN (${PL(req)}) AND b.checkout>=? AND b.checkin<=? AND b.status<>'cancelled' ORDER BY b.checkin`).all(from, to));
}));
app.post('/api/bookings', need('manager'), wrap((req, res) => {
  const b = req.body || {};
  if (!isDate(b.checkin) || !isDate(b.checkout) || b.checkout <= b.checkin) throw bad('Check-out must be after check-in');
  if (!b.location_id) throw bad('Choose a room'); locOf(req, b.location_id);
  res.json({ id: db.prepare('INSERT INTO bookings(location_id,source,uid,guest,checkin,checkout) VALUES (?,?,?,?,?,?)').run(b.location_id, 'manual', crypto.randomUUID(), b.guest || null, b.checkin, b.checkout).lastInsertRowid });
}));
app.delete('/api/bookings/:id', need('manager'), wrap((req, res) => { const bk = db.prepare('SELECT location_id FROM bookings WHERE id=?').get(req.params.id); if (!bk) throw bad('Not found', 404); locOf(req, bk.location_id); db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(req.params.id); res.json({ ok: true }); }));

// ---------- properties ----------
const PROP_FIELDS = ['code', 'name', 'legal_name', 'address', 'city', 'state', 'pincode', 'phone', 'email', 'gstin', 'checkin_time', 'checkout_time', 'notes'];
app.get('/api/properties', wrap((req, res) => {
  const t = today();
  const rows = db.prepare(`SELECT p.*,
    (SELECT COUNT(*) FROM locations l WHERE l.property_id=p.id AND l.type='room' AND l.active=1) AS rooms,
    (SELECT COUNT(*) FROM locations l WHERE l.property_id=p.id AND l.type='store' AND l.active=1) AS stores
    FROM properties p ${req.user.role === 'admin' ? '' : `WHERE p.id IN (${req.allowed.map(Number).join(',') || '0'})`} ORDER BY p.active DESC,p.name`).all();
  res.json(rows);
}));
function cleanProp(b) {
  const o = {}; for (const f of PROP_FIELDS) o[f] = (b[f] == null ? '' : String(b[f])).trim() || null;
  if (!o.name) throw bad('Property name is required');
  if (!o.code) throw bad('Property code is required');
  if (!/^[A-Za-z0-9_-]{2,12}$/.test(o.code)) throw bad('Code must be 2-12 letters or digits (e.g. JPR1)');
  o.code = o.code.toUpperCase();
  if (o.email && !/^\S+@\S+\.\S+$/.test(o.email)) throw bad('Email address looks wrong');
  for (const f of ['checkin_time', 'checkout_time']) if (o[f] && !/^\d{2}:\d{2}$/.test(o[f])) throw bad('Times must look like 12:00');
  return o;
}
app.post('/api/properties', need(), wrap((req, res) => {
  const o = cleanProp(req.body || {});
  try {
    const r = db.prepare(`INSERT INTO properties(${PROP_FIELDS.join(',')}) VALUES (${PROP_FIELDS.map(() => '?').join(',')})`).run(...PROP_FIELDS.map(f => o[f]));
    res.json({ id: r.lastInsertRowid });
  } catch { throw bad('That property code is already used'); }
}));
app.put('/api/properties/:id', need(), wrap((req, res) => {
  const p = db.prepare('SELECT * FROM properties WHERE id=?').get(req.params.id); if (!p) throw bad('Not found', 404);
  const o = cleanProp({ ...p, ...req.body });
  const active = req.body.active === undefined ? p.active : (req.body.active ? 1 : 0);
  if (!active && db.prepare('SELECT COUNT(*) c FROM properties WHERE active=1 AND id<>?').get(p.id).c === 0) throw bad('At least one property must stay active');
  let ms = p.main_store_id;
  if (req.body.main_store_id !== undefined) {
    ms = req.body.main_store_id ? Number(req.body.main_store_id) : null;
    if (ms && !db.prepare('SELECT 1 FROM locations WHERE id=? AND property_id=?').get(ms, p.id)) throw bad('That store does not belong to this property');
  }
  try {
    db.prepare(`UPDATE properties SET ${PROP_FIELDS.map(f => f + '=?').join(',')},active=?,main_store_id=? WHERE id=?`).run(...PROP_FIELDS.map(f => o[f]), active, ms, p.id);
  } catch { throw bad('That property code is already used'); }
  res.json({ ok: true });
}));

app.get('/api/settings', need(), wrap((req, res) => res.json({
  pms_api_key: getSetting('pms_api_key'), main_store_id: mainStore(req.pid), last_sync: getSetting('last_sync'),
  pms_endpoint: `${req.protocol}://${req.get('host')}/api/pms/event`
})));
app.put('/api/settings', need(), wrap((req, res) => {
  if (req.body.main_store_id) {
    const pid = pickProp(req, req.body.property_id); const l = locOf(req, req.body.main_store_id);
    if (l.property_id !== pid) throw bad('That store belongs to a different property');
    db.prepare('UPDATE properties SET main_store_id=? WHERE id=?').run(l.id, pid);
  }
  if (req.body.regenerate_key) setSetting('pms_api_key', crypto.randomBytes(20).toString('hex'));
  res.json({ ok: true });
}));


// ---------- push notifications & reminders ----------
let webpush = null;
try { webpush = require('web-push'); } catch { console.warn('web-push not installed: push notifications disabled'); }
if (webpush) {
  if (!getSetting('vapid_public')) { const k = webpush.generateVAPIDKeys(); setSetting('vapid_public', k.publicKey); setSetting('vapid_private', k.privateKey); }
  webpush.setVapidDetails('mailto:' + (process.env.ADMIN_EMAIL || 'admin@example.com'), getSetting('vapid_public'), getSetting('vapid_private'));
}
const NOTIFY_TYPES = {
  briefing: 'Morning briefing: arrivals, departures, rooms to clean',
  cleaning: 'A room needs cleaning (right after checkout)',
  lowstock: 'Low stock and restock reminders',
  approvals: 'Expenses waiting for approval',
  warranty: 'Warranties expiring within 7 days'
};
const DEFAULT_NOTIFY = { admin: Object.keys(NOTIFY_TYPES), manager: Object.keys(NOTIFY_TYPES), accounts: ['approvals'], housekeeping: ['briefing', 'cleaning'] };
const userNotify = u => u.notify != null ? String(u.notify).split(',').filter(Boolean) : (DEFAULT_NOTIFY[u.role] || []);
async function sendTo(sub, payload) {
  try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 6 * 3600 }); return true; }
  catch (e) { if (process.env.PUSH_DEBUG) console.error('push error', e.message); if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE id=?').run(sub.id); return false; }
}
// send a notification of `type` about property `propId` to everyone who wants it and may see that property
function notify(type, propId, payload) {
  if (!webpush) return;
  const multi = db.prepare('SELECT COUNT(*) c FROM properties WHERE active=1').get().c > 1;
  const pn = db.prepare('SELECT name FROM properties WHERE id=?').get(propId)?.name;
  const msg = { icon: '/icon-192.png', ...payload, title: multi && pn ? `${payload.title} · ${pn}` : payload.title };
  const users = db.prepare('SELECT id,role,active,property_ids,notify FROM users WHERE active=1').all();
  for (const u of users) {
    if (!userNotify(u).includes(type) || !allowedProps(u).includes(Number(propId))) continue;
    for (const sub of db.prepare('SELECT * FROM push_subs WHERE user_id=?').all(u.id)) sendTo(sub, msg);
  }
}
const onceKey = key => { if (db.prepare('SELECT 1 FROM reminders_sent WHERE key=?').get(key)) return false; db.prepare('INSERT INTO reminders_sent(key) VALUES (?)').run(key); return true; };
const nowHM = () => { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
// a reminder slot is "due" from its time until 3 hours later (so a restart late in the evening does not replay the morning)
const slotDue = hm => { const [h, m] = hm.split(':').map(Number); const end = pad(Math.min(23, h + 3)) + ':' + pad(m); return nowHM() >= hm && nowHM() < end; };
function runReminders() {
  if (!webpush) return;
  const t = today();
  for (const p of db.prepare('SELECT id,name FROM properties WHERE active=1').all()) {
    const pl = String(p.id);
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    if (slotDue('08:00') && onceKey(`${t}|briefing|${p.id}`)) {
      const bk = `FROM bookings b JOIN locations l ON l.id=b.location_id WHERE l.property_id=${p.id} AND b.status NOT IN ('cancelled','blocked')`;
      const arr = one(`SELECT COUNT(*) c ${bk} AND b.checkin=?`, t).c, dep = one(`SELECT COUNT(*) c ${bk} AND b.checkout=?`, t).c;
      const dirty = one(`SELECT COUNT(*) c FROM locations WHERE property_id=${p.id} AND type='room' AND active=1 AND status='dirty'`).c;
      if (arr + dep + dirty) notify('briefing', p.id, { title: 'Today at a glance', body: `${arr} arrival(s), ${dep} departure(s) · ${dirty} room(s) to clean`, url: '#/', tag: 'briefing' });
    }
    if (slotDue('09:00') && onceKey(`${t}|lowstock|${p.id}`)) {
      const low = lowStock(pl).length, rs = restockNeeds(null, pl).length;
      if (low || rs) notify('lowstock', p.id, { title: 'Stock needs attention', body: [low ? `${low} item(s) low in store` : '', rs ? `${rs} restock line(s) for rooms` : ''].filter(Boolean).join(' · '), url: low ? '#/reports/low' : '#/restock', tag: 'lowstock' });
    }
    for (const slot of ['10:00', '17:00'])
      if (slotDue(slot) && onceKey(`${t}|approvals|${slot}|${p.id}`)) {
        const pend = one(`SELECT COUNT(*) n,COALESCE(SUM(amount),0) t FROM expenses WHERE status='pending' AND property_id=${p.id}`);
        if (pend.n) notify('approvals', p.id, { title: 'Expenses waiting for approval', body: `${pend.n} expense(s) · ₹${Math.round(pend.t).toLocaleString('en-IN')}`, url: '#/expenses?s=pending', tag: 'approvals' });
      }
    if (slotDue('09:30') && onceKey(`${t}|warranty|${p.id}`)) {
      const w = one(`SELECT COUNT(*) c FROM assets a JOIN locations l ON l.id=a.location_id WHERE l.property_id=${p.id} AND a.condition<>'retired' AND a.warranty_until BETWEEN ? AND date(?,'+7 day')`, t, t).c;
      if (w) notify('warranty', p.id, { title: 'Warranty expiring soon', body: `${w} asset(s) go out of warranty within 7 days`, url: '#/assets', tag: 'warranty' });
    }
  }
  db.prepare("DELETE FROM reminders_sent WHERE sent_at < datetime('now','-10 day')").run();
}
setInterval(() => { try { runReminders(); } catch (e) { console.error('reminders', e.message); } }, 5 * 60e3).unref();

app.get('/api/push/config', wrap((req, res) => {
  const mine = db.prepare('SELECT notify FROM users WHERE id=?').get(req.user.id);
  const u = { ...req.user, notify: mine.notify };
  res.json({ supported: !!webpush, key: webpush ? getSetting('vapid_public') : null, types: NOTIFY_TYPES, enabled: userNotify(u), devices: db.prepare('SELECT COUNT(*) c FROM push_subs WHERE user_id=?').get(req.user.id).c });
}));
app.post('/api/push/subscribe', wrap((req, res) => {
  const s = req.body || {};
  if (!s.endpoint || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) throw bad('Invalid subscription');
  db.prepare('INSERT INTO push_subs(user_id,endpoint,p256dh,auth,ua) VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth')
    .run(req.user.id, s.endpoint, s.keys.p256dh, s.keys.auth, String(req.headers['user-agent'] || '').slice(0, 200));
  res.json({ ok: true });
}));
app.post('/api/push/unsubscribe', wrap((req, res) => { db.prepare('DELETE FROM push_subs WHERE endpoint=? AND user_id=?').run(String(req.body?.endpoint || ''), req.user.id); res.json({ ok: true }); }));
app.put('/api/push/prefs', wrap((req, res) => {
  const list = (Array.isArray(req.body?.types) ? req.body.types : []).filter(t => NOTIFY_TYPES[t]);
  db.prepare('UPDATE users SET notify=? WHERE id=?').run(list.join(','), req.user.id); res.json({ ok: true });
}));
app.post('/api/push/test', wrap(async (req, res) => {
  if (!webpush) throw bad('Push is not available on this server');
  const subs = db.prepare('SELECT * FROM push_subs WHERE user_id=?').all(req.user.id);
  if (!subs.length) throw bad('Turn notifications on for this device first');
  const r = await Promise.all(subs.map(s => sendTo(s, { title: 'Papppy Stays', body: 'Notifications are working 🎉', url: '#/', icon: '/icon-192.png' })));
  res.json({ sent: r.filter(Boolean).length });
}));

// ---------- barcode / lookup ----------
app.get('/api/barcode', wrap((req, res) => {
  const t = String(req.query.text || '').slice(0, 60); if (!t || !/^[\x20-\x7e]+$/.test(t)) throw bad('Invalid barcode text');
  res.type('image/svg+xml').send(bwipjs.toSVG({ bcid: 'code128', text: t, height: 14, scale: 2, includetext: false, paddingwidth: 6, paddingheight: 2 }));
}));
app.get('/api/resolve', wrap((req, res) => {
  const code = String(req.query.code || '').trim(); if (!code) throw bad('code required');
  const a = db.prepare('SELECT a.id,l.property_id FROM assets a LEFT JOIN locations l ON l.id=a.location_id WHERE a.tag=?').get(code);
  if (a) { if (a.property_id && !canProp(req, a.property_id)) throw bad('That asset belongs to a property you cannot access', 403); return res.json({ type: 'asset', id: a.id, property_id: a.property_id }); }
  const l = db.prepare('SELECT id,property_id FROM locations WHERE code=?').get(code);
  if (l) { if (!canProp(req, l.property_id)) throw bad('That location belongs to a property you cannot access', 403); return res.json({ type: 'location', id: l.id, property_id: l.property_id }); }
  const i = db.prepare('SELECT id FROM items WHERE barcode=? OR sku=?').get(code, code);
  if (i) return res.json({ type: 'item', id: i.id });
  res.status(404).json({ error: `Nothing found for code "${code}"` });
}));

// ---------- dashboard & reports ----------
const inProp = (col, pl) => `${col} IN (SELECT id FROM locations WHERE property_id IN (${pl}))`;
app.get('/api/dashboard', wrap((req, res) => {
  const t = today(); const month = t.slice(0, 7); const pl = PL(req);
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const rooms = one(`SELECT COUNT(*) c FROM locations WHERE type='room' AND active=1 AND property_id IN (${pl})`).c;
  const bk = `FROM bookings b JOIN locations l ON l.id=b.location_id WHERE l.property_id IN (${pl})`;
  const occ = one(`SELECT COUNT(DISTINCT b.location_id) c ${bk} AND b.status NOT IN ('cancelled','checked_out','blocked') AND b.checkin<=? AND b.checkout>?`, t, t).c;
  const arrivals = one(`SELECT COUNT(*) c ${bk} AND b.status NOT IN ('cancelled','blocked') AND b.checkin=?`, t).c;
  const departures = one(`SELECT COUNT(*) c ${bk} AND b.status NOT IN ('cancelled','blocked') AND b.checkout=?`, t).c;
  const dirty = one(`SELECT COUNT(*) c FROM locations WHERE type='room' AND active=1 AND status='dirty' AND property_id IN (${pl})`).c;
  const low = lowStock(pl).length;
  const ast = `FROM assets a JOIN locations l ON l.id=a.location_id WHERE l.property_id IN (${pl})`;
  const missingAssets = one(`SELECT COUNT(*) c ${ast} AND a.condition='missing'`).c;
  const repair = one(`SELECT COUNT(*) c ${ast} AND a.condition IN ('needs_repair','under_repair')`).c;
  const warranty = one(`SELECT COUNT(*) c ${ast} AND a.warranty_until IS NOT NULL AND a.warranty_until BETWEEN ? AND date(?,'+30 day') AND a.condition<>'retired'`, t, t).c;
  const spend = one(`SELECT COALESCE(SUM(amount),0) t FROM expenses WHERE substr(date,1,7)=? AND status<>'rejected' AND property_id IN (${pl})`, month).t;
  const pending = one(`SELECT COUNT(*) n,COALESCE(SUM(amount),0) t FROM expenses WHERE status='pending' AND property_id IN (${pl})`);
  const restock = restockNeeds(null, pl).length;
  const by_property = req.pid ? [] : db.prepare(`SELECT p.id,p.name,
      (SELECT COUNT(*) FROM locations l WHERE l.property_id=p.id AND l.type='room' AND l.active=1) AS rooms,
      (SELECT COUNT(DISTINCT b.location_id) FROM bookings b JOIN locations l ON l.id=b.location_id WHERE l.property_id=p.id AND b.status NOT IN ('cancelled','checked_out','blocked') AND b.checkin<=? AND b.checkout>?) AS occupied,
      (SELECT COALESCE(SUM(amount),0) FROM expenses e WHERE e.property_id=p.id AND substr(e.date,1,7)=? AND e.status<>'rejected') AS month_spend
      FROM properties p WHERE p.id IN (${pl}) ORDER BY p.name`).all(t, t, month);
  res.json({ date: t, rooms, occupied: occ, arrivals, departures, dirty, low_stock: low, missing_assets: missingAssets, assets_in_repair: repair, warranties_expiring: warranty, month_spend: spend, pending_expenses: pending, restock_lines: restock, last_sync: getSetting('last_sync'), by_property });
}));
function lowStock(pl) {
  // "available" stock = non-room locations (stores); rooms hold their own par
  return db.prepare(`SELECT i.id,i.name,i.unit,i.reorder_level,COALESCE(sup.name,'') AS supplier,
    COALESCE((SELECT SUM(s.qty) FROM stock s JOIN locations l ON l.id=s.location_id WHERE s.item_id=i.id AND l.type<>'room' AND l.property_id IN (${pl})),0) AS qty
    FROM items i LEFT JOIN suppliers sup ON sup.id=i.supplier_id WHERE i.kind='consumable' AND i.active=1 AND i.reorder_level>0`).all().filter(r => r.qty <= r.reorder_level);
}
app.get('/api/reports/lowstock', wrap((req, res) => res.json(lowStock(PL(req)))));
app.get('/api/reports/consumption', need('manager', 'accounts'), wrap((req, res) => {
  const from = isDate(req.query.from) ? req.query.from : today().slice(0, 8) + '01'; const to = isDate(req.query.to) ? req.query.to : today();
  const pl = PL(req);
  // distinct room-nights (a PMS booking and its Airbnb mirror must not double count)
  const nightSet = new Set(); const d0 = +new Date(from + 'T00:00:00'), d1 = +new Date(to + 'T00:00:00');
  for (const b of db.prepare(`SELECT location_id,checkin,checkout FROM bookings WHERE status NOT IN ('cancelled','blocked') AND checkout>? AND checkin<=? AND ${inProp('location_id', pl)}`).all(from, to))
    for (let t = Math.max(+new Date(b.checkin + 'T00:00:00'), d0); t < +new Date(b.checkout + 'T00:00:00') && t <= d1; t += 864e5) nightSet.add(b.location_id + '|' + ymd(new Date(t)));
  const nights = nightSet.size;
  const rows = db.prepare(`SELECT i.id,i.name,i.unit,i.cost,SUM(m.qty) AS used FROM movements m JOIN items i ON i.id=m.item_id
    WHERE m.type='consume' AND date(m.ts)>=? AND date(m.ts)<=? AND ${inProp('m.from_loc', pl)} GROUP BY i.id ORDER BY used DESC`).all(from, to)
    .map(r => ({ ...r, per_night: nights ? r.used / nights : null, value: r.used * r.cost }));
  res.json({ from, to, occupied_nights: nights, rows });
}));
app.get('/api/reports/valuation', need('manager', 'accounts'), wrap((req, res) => {
  const pl = PL(req);
  res.json({
    stock: db.prepare(`SELECT l.name AS location,SUM(s.qty*i.cost) AS value FROM stock s JOIN items i ON i.id=s.item_id JOIN locations l ON l.id=s.location_id WHERE l.property_id IN (${pl}) GROUP BY l.id HAVING value>0 ORDER BY value DESC`).all(),
    assets: db.prepare(`SELECT COUNT(*) n,COALESCE(SUM(a.cost),0) value FROM assets a JOIN locations l ON l.id=a.location_id WHERE a.condition<>'retired' AND l.property_id IN (${pl})`).get()
  });
}));

// admin-only database backup download (copy the uploads folder separately for receipt photos)
app.get('/api/backup', need(), (req, res) => {
  const f = path.join(DATA_DIR, `backup-${Date.now()}.db`);
  db.backup(f).then(() => res.download(f, `hotel-backup-${today()}.db`, () => fs.unlink(f, () => { })))
    .catch(e => fail(res, 500, e.message));
});

// error handler (multer etc.)
app.use((err, req, res, next) => { if (err) return fail(res, err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400), err.code === 'LIMIT_FILE_SIZE' ? 'Photo is too large (max 12 MB)' : err.message); next(); });

// ---------- first run ----------
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const pw = process.env.ADMIN_PASSWORD || 'admin12345';
  db.prepare('INSERT INTO users(name,email,password_hash,role) VALUES (?,?,?,?)').run('Administrator', process.env.ADMIN_EMAIL || 'admin@hotel.local', bcrypt.hashSync(pw, 10), 'admin');
  console.log(`First run: created admin ${process.env.ADMIN_EMAIL || 'admin@hotel.local'} / ${process.env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD)' : pw} — change this password after signing in.`);
}

// Always listen: Hostinger's Node.js host loads the entry file itself, so a
// `require.main === module` guard would stop the server from ever starting.
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Papppy Stays app running on port ${port}`));
module.exports = { app, runReminders, notify };
