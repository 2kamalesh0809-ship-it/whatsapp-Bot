// auth.js
const { run, get } = require('./db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
dotenv.config();

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;

// Ensure admin user exists in DB
async function ensureAdminUser() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.warn('ADMIN_EMAIL or ADMIN_PASSWORD not set in .env');
    return;
  }

  const existing = await get('SELECT * FROM admin_users WHERE email = ?', [ADMIN_EMAIL]);
  if (existing) {
    console.log('Admin user already exists:', ADMIN_EMAIL);
    return;
  }

  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  await run('INSERT INTO admin_users (email, password_hash) VALUES (?, ?)', [
    ADMIN_EMAIL,
    hash
  ]);

  console.log('Admin user created:', ADMIN_EMAIL);
}

// Login function returns JWT token or null
async function login(email, password) {
  const user = await get('SELECT * FROM admin_users WHERE email = ?', [email]);
  if (!user) return null;

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return null;

  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, {
    expiresIn: '8h'
  });
  return token;
}

// Express middleware to protect routes
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const [type, token] = header.split(' ');
  if (type !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = {
  ensureAdminUser,
  login,
  authMiddleware
};
