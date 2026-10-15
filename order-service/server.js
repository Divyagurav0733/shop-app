const express = require('express');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 6000;
const USER_URL = process.env.USER_SERVICE_URL;       // http://<user-vm-internal-ip>:5000
const PRODUCT_URL = process.env.PRODUCT_SERVICE_URL; // http://<product-vm-internal-ip>:4000

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const postJson = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function initDb() {
  for (let i = 0; i < 30; i++) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        total DECIMAL(10,2) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PLACED',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS order_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        product_id INT NOT NULL,
        product_name VARCHAR(150),
        unit_price DECIMAL(10,2) NOT NULL,
        quantity INT NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
      )`);
      console.log('order-service: database ready');
      return;
    } catch (e) {
      console.log('order-service: waiting for database...', e.code || e.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  process.exit(1);
}

async function releaseAll(reserved) {
  for (const r of reserved) {
    try {
      await postJson(`${PRODUCT_URL}/internal/products/${r.productId}/release`, { quantity: r.quantity });
    } catch (e) {
      console.error('stock release failed', r, e.message);
    }
  }
}

app.get('/health', (req, res) => res.json({ service: 'order', status: 'ok' }));

app.get('/orders', wrap(async (req, res) => {
  const { userId } = req.query;
  const [rows] = userId
    ? await pool.query('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC', [userId])
    : await pool.query('SELECT * FROM orders ORDER BY id DESC');
  res.json(rows);
}));

app.get('/orders/:id', wrap(async (req, res) => {
  const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'order not found' });
  const [items] = await pool.query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
  res.json({ ...order, items });
}));

// Place an order: verify user (sync call to user-vm), reserve stock (sync calls to product-vm),
// then write the order to MySQL. If anything fails, stock reservations are released.
app.post('/orders', wrap(async (req, res) => {
  const { userId, items } = req.body;
  if (!userId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'userId and a non-empty items[] are required' });
  }

  // 1. Verify the user exists in user-service
  const userRes = await fetch(`${USER_URL}/users/${encodeURIComponent(userId)}`);
  if (!userRes.ok) return res.status(400).json({ error: 'unknown user' });

  // 2. Reserve stock for each item in product-service
  const reserved = [];
  const lines = [];
  try {
    for (const item of items) {
      const pRes = await postJson(
        `${PRODUCT_URL}/internal/products/${encodeURIComponent(item.productId)}/reserve`,
        { quantity: item.quantity });
      if (!pRes.ok) {
        const body = await pRes.json().catch(() => ({}));
        throw new HttpError(409, body.error || 'stock reservation failed');
      }
      const product = await pRes.json();
      reserved.push({ productId: product.id, quantity: item.quantity });
      lines.push({
        productId: product.id,
        name: product.name,
        price: Number(product.price),
        quantity: item.quantity,
      });
    }
  } catch (err) {
    await releaseAll(reserved);
    return res.status(err.status || 502).json({ error: err.message });
  }

  // 3. Save the order in MySQL (transaction)
  const total = lines.reduce((s, l) => s + l.price * l.quantity, 0);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [o] = await conn.query(
      'INSERT INTO orders (user_id, total, status) VALUES (?, ?, ?)',
      [userId, total.toFixed(2), 'PLACED']);
    for (const l of lines) {
      await conn.query(
        'INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity) VALUES (?, ?, ?, ?, ?)',
        [o.insertId, l.productId, l.name, l.price, l.quantity]);
    }
    await conn.commit();
    res.status(201).json({ orderId: o.insertId, total: total.toFixed(2), status: 'PLACED', items: lines });
  } catch (e) {
    await conn.rollback();
    await releaseAll(reserved);
    throw e;
  } finally {
    conn.release();
  }
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

initDb().then(() => app.listen(PORT, () => console.log(`order-service listening on ${PORT}`)));
