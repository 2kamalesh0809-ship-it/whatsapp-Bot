// patch-db.js
const { run } = require('./db');

async function patch() {
  try {
    // Create products table if not exists
    await run(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        stock INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1
      );
    `);

    // Try to add invoice columns (ignore errors if they already exist)
    try {
      await run(`ALTER TABLE orders ADD COLUMN invoice_no TEXT;`);
    } catch { }
    try {
      await run(`ALTER TABLE orders ADD COLUMN invoice_pdf TEXT;`);
    } catch { }

    // Seed some products if table empty
    const { get } = require('./db');
    const row = await get('SELECT COUNT(*) as c FROM products');
    if (!row || row.c === 0) {
      await run(`
        INSERT INTO products (id, name, price, stock, active) VALUES
        ('FP1',  '1 Month Fitness Program', 1999, 1000, 1),
        ('FP3',  '3 Month Fitness Program', 4999, 1000, 1),
        ('FP6',  '6 Month Fitness Program', 8999, 1000, 1),
        ('WHEY1', 'Gold Standard Whey (2kg)', 5499, 50, 1),
        ('ISO1',  'Dymatize ISO100 (5lb)', 6499, 30, 1),
        ('MB1',   'MuscleBlaze Whey (1kg)', 2999, 100, 1),
        ('C4',    'C4 Pre-Workout', 2799, 40, 1),
        ('WRAP1', 'Gym Wrist Wraps', 799, 200, 1);
      `);
    }

    console.log('DB patch done.');
    process.exit(0);
  } catch (e) {
    console.error('DB patch error:', e);
    process.exit(1);
  }
}

patch();
