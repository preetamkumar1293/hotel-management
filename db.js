const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'hotel.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'housekeeping', active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'room',            -- room | store | other
  room_type TEXT, floor TEXT, ical_url TEXT, pms_room_id TEXT,
  status TEXT DEFAULT 'clean',                  -- clean | dirty | inspected | maintenance
  active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT, notes TEXT
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, sku TEXT UNIQUE, name TEXT NOT NULL, category TEXT,
  kind TEXT NOT NULL DEFAULT 'consumable',      -- consumable | asset
  unit TEXT DEFAULT 'pcs', barcode TEXT UNIQUE, cost REAL DEFAULT 0,
  supplier_id INTEGER REFERENCES suppliers(id), reorder_level REAL DEFAULT 0, active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS stock (
  item_id INTEGER NOT NULL REFERENCES items(id), location_id INTEGER NOT NULL REFERENCES locations(id),
  qty REAL NOT NULL DEFAULT 0, par REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, location_id)
);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY, tag TEXT UNIQUE NOT NULL, item_id INTEGER NOT NULL REFERENCES items(id),
  serial TEXT, location_id INTEGER REFERENCES locations(id), condition TEXT DEFAULT 'good', -- good|needs_repair|under_repair|retired|missing
  purchase_date TEXT, cost REAL, warranty_until TEXT, notes TEXT
);
CREATE TABLE IF NOT EXISTS room_templates (
  room_type TEXT NOT NULL, item_id INTEGER NOT NULL REFERENCES items(id), qty REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (room_type, item_id)
);
CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY, ts TEXT DEFAULT (datetime('now')), user_id INTEGER REFERENCES users(id),
  type TEXT NOT NULL,                           -- receive|issue|transfer|consume|adjust|asset_move|asset_condition|audit
  item_id INTEGER, asset_id INTEGER, from_loc INTEGER, to_loc INTEGER, qty REAL, note TEXT
);
CREATE TABLE IF NOT EXISTS audits (
  id INTEGER PRIMARY KEY, ts TEXT DEFAULT (datetime('now')), user_id INTEGER, location_id INTEGER,
  result TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY, supplier_id INTEGER REFERENCES suppliers(id), status TEXT DEFAULT 'open', -- open|received|cancelled
  created_by INTEGER, created_at TEXT DEFAULT (datetime('now')), received_at TEXT, note TEXT, expense_id INTEGER
);
CREATE TABLE IF NOT EXISTS po_lines (
  id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL REFERENCES purchase_orders(id), item_id INTEGER NOT NULL REFERENCES items(id),
  qty REAL NOT NULL, unit_cost REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS expense_categories (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, amount REAL NOT NULL, category TEXT, vendor TEXT,
  payment_method TEXT DEFAULT 'cash', description TEXT, status TEXT DEFAULT 'pending', -- pending|approved|rejected
  submitted_by INTEGER, approved_by INTEGER, decided_at TEXT, reject_reason TEXT,
  location_id INTEGER, po_id INTEGER, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS expense_photos (
  id INTEGER PRIMARY KEY, expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE, filename TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY, location_id INTEGER NOT NULL REFERENCES locations(id), source TEXT NOT NULL, -- airbnb|pms|manual
  uid TEXT NOT NULL, guest TEXT, checkin TEXT NOT NULL, checkout TEXT NOT NULL, status TEXT DEFAULT 'confirmed',
  UNIQUE (source, uid)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_mov_ts ON movements(ts);
CREATE INDEX IF NOT EXISTS idx_book_loc ON bookings(location_id, checkin, checkout);
CREATE INDEX IF NOT EXISTS idx_exp_date ON expenses(date);
`);

// ---------- multi-property ----------
db.exec(`
CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, legal_name TEXT,
  address TEXT, city TEXT, state TEXT, pincode TEXT, phone TEXT, email TEXT, gstin TEXT,
  checkin_time TEXT DEFAULT '12:00', checkout_time TEXT DEFAULT '11:00', notes TEXT,
  main_store_id INTEGER, active INTEGER DEFAULT 1
);`);
const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c);
for (const [t, c, d] of [['locations', 'property_id', 'INTEGER'], ['expenses', 'property_id', 'INTEGER'], ['purchase_orders', 'property_id', 'INTEGER'], ['users', 'property_ids', 'TEXT']])
  if (!hasCol(t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`);
if (!db.prepare('SELECT 1 FROM properties LIMIT 1').get()) {
  const ms = db.prepare("SELECT value FROM settings WHERE key='main_store_id'").get();
  db.prepare('INSERT INTO properties(code,name,legal_name,city,state,main_store_id) VALUES (?,?,?,?,?,?)')
    .run('PAP1', process.env.PROPERTY_NAME || 'Papppy Stays', 'Papppy Hospitalities', 'Jaipur', 'Rajasthan', ms ? Number(ms.value) : null);
}
const firstProp = db.prepare('SELECT MIN(id) id FROM properties').get().id;
db.exec(`UPDATE expenses SET property_id=(SELECT l.property_id FROM locations l WHERE l.id=expenses.location_id) WHERE property_id IS NULL AND location_id IS NOT NULL`);
for (const t of ['locations', 'expenses', 'purchase_orders']) db.prepare(`UPDATE ${t} SET property_id=? WHERE property_id IS NULL`).run(firstProp);
db.exec('CREATE INDEX IF NOT EXISTS idx_loc_prop ON locations(property_id); CREATE INDEX IF NOT EXISTS idx_exp_prop ON expenses(property_id);');

const DEFAULT_EXPENSE_CATS = ['Groceries & F&B', 'Housekeeping supplies', 'Maintenance & repairs', 'Utilities', 'Salaries & wages', 'Laundry', 'Marketing & commissions', 'Equipment', 'Transport', 'Miscellaneous'];
const insCat = db.prepare('INSERT OR IGNORE INTO expense_categories(name) VALUES (?)');
DEFAULT_EXPENSE_CATS.forEach(c => insCat.run(c));

const getSetting = (k, d = null) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : d; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

module.exports = { db, DATA_DIR, getSetting, setSetting };
