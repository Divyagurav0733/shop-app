const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 8080;

// Fail fast if a backend address is missing
for (const k of ['PRODUCT_SERVICE_URL', 'USER_SERVICE_URL', 'ORDER_SERVICE_URL']) {
  if (!process.env[k]) { console.error(`Missing env ${k}`); process.exit(1); }
}

app.get('/health', (req, res) => res.json({ service: 'api-gateway', status: 'ok' }));

// Sole entry point: /api/<service>/... is forwarded to the matching backend VM
app.use(createProxyMiddleware({
  pathFilter: '/api/products',
  target: process.env.PRODUCT_SERVICE_URL,
  changeOrigin: true,
  pathRewrite: { '^/api/products': '/products' },
}));

app.use(createProxyMiddleware({
  pathFilter: '/api/users',
  target: process.env.USER_SERVICE_URL,
  changeOrigin: true,
  pathRewrite: { '^/api/users': '/users' },
}));

app.use(createProxyMiddleware({
  pathFilter: '/api/orders',
  target: process.env.ORDER_SERVICE_URL,
  changeOrigin: true,
  pathRewrite: { '^/api/orders': '/orders' },
}));

app.use((req, res) => res.status(404).json({ error: 'route not found' }));

app.listen(PORT, () => console.log(`api-gateway listening on ${PORT}`));
