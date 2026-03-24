// services.js
const { run, get, all } = require('./db');

// ---- SESSION PERSISTENCE ----
async function getSessionState(waId) {
  const row = await get('SELECT state_json FROM sessions WHERE wa_id = ?', [waId]);
  if (!row) return null;
  try {
    return JSON.parse(row.state_json);
  } catch {
    return null;
  }
}

async function saveSessionState(waId, state) {
  const json = JSON.stringify(state);
  const existing = await get('SELECT id FROM sessions WHERE wa_id = ?', [waId]);
  if (existing) {
    await run(
      'UPDATE sessions SET state_json = ?, updated_at = datetime("now") WHERE wa_id = ?',
      [json, waId]
    );
  } else {
    await run(
      'INSERT INTO sessions (wa_id, state_json) VALUES (?, ?)',
      [waId, json]
    );
  }
}

// ---- CUSTOMER + ORDER ----
async function getOrCreateCustomer(waId, phone, name) {
  let row = await get('SELECT * FROM customers WHERE wa_id = ?', [waId]);
  if (row) return row;

  await run(
    'INSERT INTO customers (wa_id, phone, name) VALUES (?, ?, ?)',
    [waId, phone, name || null]
  );
  row = await get('SELECT * FROM customers WHERE wa_id = ?', [waId]);
  return row;
}

async function createOrder(order, waId) {
  // order = { items, total, paymentMethod, address, pincode, name }
  const customer = await getOrCreateCustomer(
    waId,
    waId.replace('@c.us', ''),
    order.name
  );

  const orderCode = 'MRC' + Date.now();
  const info = await run(
    'INSERT INTO orders (order_code, customer_id, total, payment_method, status, address, pincode, tracking_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [orderCode, customer.id, order.total, order.paymentMethod, 'PENDING', order.address, order.pincode, null]
  );
  const orderId = info.lastID;

  for (const item of order.items) {
    await run(
      'INSERT INTO order_items (order_id, product_id, name, qty, price, line_total) VALUES (?, ?, ?, ?, ?, ?)',
      [orderId, item.productId, item.name, item.qty, item.price, item.lineTotal]
    );
  }

  const createdOrder = await get('SELECT * FROM orders WHERE id = ?', [orderId]);
  return { order: createdOrder, orderCode, customer };
}

async function getRecentOrders(limit = 20) {
  const rows = await all(
    `SELECT o.*, c.name as customer_name, c.phone as customer_phone
     FROM orders o
     JOIN customers c ON o.customer_id = c.id
     ORDER BY o.id DESC
     LIMIT ?`,
    [limit]
  );

  const result = [];
  for (const o of rows) {
    const items = await all('SELECT * FROM order_items WHERE order_id = ?', [o.id]);
    result.push({ ...o, items });
  }
  return result;
}

async function getOrderByCode(orderCode) {
  const order = await get(
    `SELECT o.*, c.name as customer_name, c.phone as customer_phone, c.wa_id
     FROM orders o
     JOIN customers c ON o.customer_id = c.id
     WHERE o.order_code = ?`,
    [orderCode]
  );
  if (!order) return null;
  const items = await all('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
  return { ...order, items };
}

async function saveClientLead(waId, data) {
  // data = { name, phone, location, goal }
  await run(
    'INSERT INTO client_leads (wa_id, name, phone, location, goal) VALUES (?, ?, ?, ?, ?)',
    [waId, data.name, data.phone, data.location, data.goal]
  );
}

async function saveCoachLead(waId, data) {
  // data = { name, city, specialization, experience }
  await run(
    'INSERT INTO coach_leads (wa_id, name, city, specialization, experience) VALUES (?, ?, ?, ?, ?)',
    [waId, data.name, data.city, data.specialization, data.experience]
  );
}

async function getClientLeads() {
  return await all('SELECT * FROM client_leads ORDER BY id DESC');
}

async function getCoachLeads() {
  return await all('SELECT * FROM coach_leads ORDER BY id DESC');
}

async function updateClientStatus(id, status) {
  return await run('UPDATE client_leads SET status = ? WHERE id = ?', [status, id]);
}

async function updateCoachStatus(id, status) {
  return await run('UPDATE coach_leads SET status = ? WHERE id = ?', [status, id]);
}

async function getLeadStats() {
  const q = `
    SELECT 
      (SELECT COUNT(*) FROM client_leads) as total_clients,
      (SELECT COUNT(*) FROM coach_leads) as total_coaches,
      (SELECT COUNT(*) FROM client_leads WHERE DATE(created_at) = DATE('now')) +
      (SELECT COUNT(*) FROM coach_leads WHERE DATE(created_at) = DATE('now')) as today_leads,
      (SELECT COUNT(*) FROM client_leads WHERE status = 'PENDING') +
      (SELECT COUNT(*) FROM coach_leads WHERE status = 'PENDING') as pending_leads,
      (SELECT COUNT(*) FROM client_leads WHERE status = 'COMPLETED') +
      (SELECT COUNT(*) FROM coach_leads WHERE status = 'COMPLETED') as completed_leads
  `;
  return await get(q);
}

module.exports = {
  getSessionState,
  saveSessionState,
  createOrder,
  getRecentOrders,
  getOrderByCode,
  saveClientLead,
  saveCoachLead,
  getClientLeads,
  getCoachLeads,
  updateClientStatus,
  updateCoachStatus,
  getLeadStats
};
