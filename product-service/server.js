const express = require('express');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 4000;

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function initDb() {
  for (let i = 0; i < 30; i++) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        description TEXT,
        price DECIMAL(10,2) NOT NULL,
        stock INT NOT NULL DEFAULT 0,
        image_url VARCHAR(300)
      )`);
      const [[{ c }]] = await pool.query('SELECT COUNT(*) AS c FROM products');
      if (c === 0) {
        await pool.query(`INSERT INTO products (name, description, price, stock) VALUES
          ('Wireless Headphones', 'Noise-cancelling over-ear headphones', 129.99, 25),
          ('Running Shoes', 'Lightweight everyday trainers', 79.50, 40),
          ('Coffee Mug', 'Ceramic 350ml mug', 12.00, 100)`);
      }
      console.log('product-service: database ready');
      return;
    } catch (e) {
      console.log('product-service: waiting for database...', e.code || e.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  process.exit(1);
}

app.get('/health', (req, res) => res.json({ service: 'product', status: 'ok' }));

app.get('/products', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM products ORDER BY id');
  res.json(rows);
}));

app.get('/products/:id', wrap(async (req, res) => {
  const [[p]] = await pool.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'product not found' });
  res.json(p);
}));

app.post('/products', wrap(async (req, res) => {
  const { name, description = '', price, stock = 0, image_url = null } = req.body;
  if (!name || typeof price !== 'number' || price < 0) {
    return res.status(400).json({ error: 'name and a non-negative numeric price are required' });
  }
  const [r] = await pool.query(
    'INSERT INTO products (name, description, price, stock, image_url) VALUES (?,?,?,?,?)',
    [name, description, price, stock, image_url]);
  const [[p]] = await pool.query('SELECT * FROM products WHERE id = ?', [r.insertId]);
  res.status(201).json(p);
}));

// ---- Internal endpoints, called only by order-service (backend-to-backend) ----

// Atomically decrement stock; fails if not enough left
app.post('/internal/products/:id/reserve', wrap(async (req, res) => {
  const qty = Number(req.body.quantity);
  if (!Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ error: 'quantity must be a positive integer' });
  }
  const [r] = await pool.query(
    'UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?',
    [qty, req.params.id, qty]);
  if (r.affectedRows === 0) {
    return res.status(409).json({ error: `not enough stock for product ${req.params.id}` });
  }
  const [[p]] = await pool.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
  res.json(p);
}));

// Give stock back (compensation when an order fails part way)
app.post('/internal/products/:id/release', wrap(async (req, res) => {
  const qty = Number(req.body.quantity);
  if (!Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ error: 'quantity must be a positive integer' });
  }
  await pool.query('UPDATE products SET stock = stock + ? WHERE id = ?', [qty, req.params.id]);
  res.json({ released: true });
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

initDb().then(() => app.listen(PORT, () => console.log(`product-service listening on ${PORT}`)));
