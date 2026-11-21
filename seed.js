// Demo data: node seed.js  (only run on a fresh database)
const { db } = require('./db');
if (db.prepare('SELECT COUNT(*) c FROM locations').get().c) { console.log('Database already has data; not seeding.'); process.exit(0); }
const loc = db.prepare('INSERT INTO locations(code,name,type,room_type,floor) VALUES (?,?,?,?,?)');
const store = loc.run('S-MAIN', 'Main Store', 'store', null, 'G').lastInsertRowid;
loc.run('S-HK', 'Housekeeping Closet', 'store', null, '1'); loc.run('S-LAUNDRY', 'Laundry', 'other', null, 'G');
const rooms = [];
for (let n = 101; n <= 110; n++) rooms.push(loc.run('R-' + n, 'Room ' + n, 'room', n % 5 === 0 ? 'Suite' : 'Deluxe', '1').lastInsertRowid);
const sup = db.prepare('INSERT INTO suppliers(name,phone) VALUES (?,?)').run('City Hotel Supplies', '+91 90000 00000').lastInsertRowid;
const it = db.prepare('INSERT INTO items(sku,name,category,kind,unit,barcode,cost,supplier_id,reorder_level) VALUES (?,?,?,?,?,?,?,?,?)');
const mk = (sku, n, c, k, u, cost, rl) => { const id = it.run(sku, n, c, k, u, null, cost, sup, rl).lastInsertRowid; db.prepare('UPDATE items SET barcode=? WHERE id=?').run('I' + String(id).padStart(5, '0'), id); return id; };
const soap = mk('AMN-SOAP', 'Bath soap bar', 'Amenities', 'consumable', 'pcs', 8, 100);
const shampoo = mk('AMN-SHAM', 'Shampoo sachet', 'Amenities', 'consumable', 'pcs', 5, 100);
const water = mk('MB-WATER', 'Water bottle 500ml', 'Minibar', 'consumable', 'pcs', 12, 60);
const tea = mk('MB-TEA', 'Tea bags', 'Minibar', 'consumable', 'pcs', 3, 80);
const towel = mk('LIN-TOWEL', 'Bath towel', 'Linen', 'consumable', 'pcs', 250, 30);
const tv = mk('AST-TV', 'Television 43"', 'Electronics', 'asset', 'pcs', 24000, 0);
const kettle = mk('AST-KET', 'Electric kettle', 'Electronics', 'asset', 'pcs', 900, 0);
const safe = mk('AST-SAFE', 'In-room safe', 'Electronics', 'asset', 'pcs', 6500, 0);
const stock = db.prepare('INSERT INTO stock(item_id,location_id,qty,par) VALUES (?,?,?,?)');
[[soap, 300], [shampoo, 300], [water, 150], [tea, 250], [towel, 60]].forEach(([i, q]) => stock.run(i, store, q, 0));
const par = { [soap]: 2, [shampoo]: 2, [water]: 2, [tea]: 4, [towel]: 3 };
const tpl = db.prepare('INSERT INTO room_templates(room_type,item_id,qty) VALUES (?,?,?)');
for (const t of ['Deluxe', 'Suite']) { [[tv, 1], [kettle, 1], [safe, 1]].forEach(([i, q]) => tpl.run(t, i, q)); }
const ast = db.prepare('INSERT INTO assets(tag,item_id,location_id,cost,purchase_date) VALUES (?,?,?,?,?)');
for (const r of rooms) {
  for (const [i, q] of Object.entries(par)) stock.run(i, r, Math.max(0, q - 1), q);
  for (const [i, cost] of [[tv, 24000], [kettle, 900], [safe, 6500]]) { const id = ast.run('T' + Math.random(), i, r, cost, '2025-01-15').lastInsertRowid; db.prepare('UPDATE assets SET tag=? WHERE id=?').run('A' + String(id).padStart(5, '0'), id); }
}
console.log('Demo data created: 10 rooms, 8 items, assets tagged A00001+.');
