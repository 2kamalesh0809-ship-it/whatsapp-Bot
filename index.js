require('dotenv').config();

const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Razorpay = require('razorpay');
const express = require('express');
const app = express();

const { init, all, get, run } = require('./db');
const { ensureAdminUser, login, authMiddleware } = require('./auth');
const {
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
} = require('./services');
const { generateInvoicePdf } = require('./invoice');
const { syncProductsFromWebsite } = require('./scraper');

const PORT = process.env.PORT || 3000;

app.get('/', (_, res) => {
  res.send('MRCoach Fitness bot is running');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

const BRAND_NAME = process.env.BRAND_NAME || 'MRCoach Fitness';
const BANK_NAME = process.env.BANK_NAME || 'Your Bank Name';
const BANK_ACC_NO = process.env.BANK_ACC_NO || '0000000000';
const BANK_IFSC = process.env.BANK_IFSC || 'ABCD0123456';

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

let razorpay = null;
if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET
  });
}

app.use(bodyParser.json());

// serve invoices as static files
app.use('/invoices', express.static(path.join(__dirname, 'invoices')));

// ---- BOT STATE ----
let waClient = null;
let botStatus = 'DISCONNECTED';
let lastBotActivity = null;

// ---- PRODUCTS (from DB) ----
async function fetchProducts() {
  const rows = await all('SELECT * FROM products WHERE active = 1 AND stock > 0');
  return rows;
}

// ---- RAZORPAY PAYMENT LINK ----
async function createPaymentLink(order, orderCode) {
  if (!razorpay) {
    return `https://example.com/pay/${orderCode}`;
  }

  const amountPaise = Math.round(order.total * 100);
  const customerName = order.name || 'Customer';
  const description = `Order ${orderCode} via WhatsApp`;

  const options = {
    amount: amountPaise,
    currency: 'INR',
    accept_partial: false,
    reference_id: orderCode,
    description,
    customer: {
      name: customerName,
      contact: order.phone || '',
      email: order.email || ''
    },
    notify: {
      sms: true,
      email: false
    },
    reminder_enable: true,
    callback_url: 'https://mrcoach.fit/payment-callback',
    callback_method: 'get'
  };

  const pl = await razorpay.paymentLink.create(options);
  return pl.short_url || pl.link || pl.id;
}

// ---- SESSION HELPERS ----
async function loadSession(waId) {
  const fromDb = await getSessionState(waId);
  if (fromDb) return fromDb;
  const initial = { step: 'MAIN_MENU', cart: [], temp: {} };
  await saveSessionState(waId, initial);
  return initial;
}

async function saveSession(waId, state) {
  await saveSessionState(waId, state);
}

async function resetSession(waId) {
  const initial = { step: 'MAIN_MENU', cart: [], temp: {} };
  await saveSession(waId, initial);
}

// ---- BOT ----
function createClient() {
  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: 'mrcoach-bot-session'
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    }
  });

  client.on('qr', qr => {
    botStatus = 'LOADING';
    console.log('Scan this QR for', BRAND_NAME, 'bot:');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    console.log('✅ Authenticated successfully!');
  });

  client.on('ready', () => {
    botStatus = 'CONNECTED';
    console.log('✅ WhatsApp bot connected AND ready!');
  });

  client.on('auth_failure', msg => {
    botStatus = 'DISCONNECTED';
    console.error('AUTH FAILURE:', msg);
  });

  client.on('disconnected', reason => {
    botStatus = 'DISCONNECTED';
    console.log('Bot disconnected:', reason);
  });

  client.on('message', msg => handleMessage(msg));

  return client;
}

async function startBot() {
  if (waClient) {
    console.log('Bot already running.');
    return;
  }
  waClient = createClient();
  botStatus = 'LOADING';
  waClient.initialize();
}

async function stopBot() {
  if (!waClient) return;
  try {
    await waClient.destroy();
  } catch (e) {
    console.error('Error while stopping bot:', e);
  }
  waClient = null;
  botStatus = 'DISCONNECTED';
}

// ---- MESSAGE HANDLER ----
async function handleMessage(msg) {
  const chatId = msg.from;
  const text = (msg.body || '').trim();
  const lower = text.toLowerCase();

  lastBotActivity = new Date();

  if (chatId.endsWith('@broadcast')) return;
  if (chatId.endsWith('@g.us')) return; // Ignore Group Messages

  let session = await loadSession(chatId);

  if (['menu', 'main', 'start'].includes(lower)) {
    await resetSession(chatId);
    session = await loadSession(chatId);
    await sendMainMenu(msg);
    return;
  }

  if (lower === 'help') {
    await msg.reply(
      `*${BRAND_NAME} Help*\n\n` +
      'Type:\n' +
      '- "menu" to see options\n' +
      '- "order" to start a new order\n' +
      '- "talk" to chat with a human\n' +
      '- "cancel" to cancel current flow'
    );
    return;
  }

  if (lower === 'cancel') {
    await resetSession(chatId);
    await msg.reply('❌ Current flow cancelled. Type "menu" to start again.');
    return;
  }

  if (lower.startsWith('track ')) {
    const parts = lower.split(' ');
    const code = (parts[1] || '').toUpperCase();
    const order = await getOrderByCode(code);
    if (!order) {
      await msg.reply('Could not find an order with that ID. Please check and try again.');
    } else {
      await msg.reply(
        `*Order ${order.order_code}*\n` +
        `Status: ${order.status}\n` +
        `Total: ₹${order.total}\n` +
        `Placed on: ${order.created_at}\n\n` +
        `Thank you for ordering from ${BRAND_NAME}!`
      );
    }
    return;
  }

  const greetings = ['hi', 'hello', 'hey', 'hii', 'hai', 'start', 'menu', BRAND_NAME.toLowerCase()];
  const acknowledgments = ['thank you', 'thanks', 'ok', 'okay', 'thx'];

  if (greetings.includes(lower)) {
    await welcomeAndMenu(msg);
    return;
  }

  if (acknowledgments.includes(lower)) {
    await resetSession(chatId);
    await msg.reply('You\'re welcome! Let us know if you need anything else from *MRCoach*. Have a great day! 💪');
    return;
  }

  try {
    switch (session.step) {
      case 'MAIN_MENU':
        await handleRoleChoice(msg, session, lower);
        break;
      case 'COLLECT_CLIENT_NAME':
        await handleClientName(msg, session, text);
        break;
      case 'COLLECT_CLIENT_GENDER':
        await handleClientGender(msg, session, lower);
        break;
      case 'COLLECT_CLIENT_LOCATION':
        await handleClientLocation(msg, session, text);
        break;
      case 'COLLECT_CLIENT_GOAL':
        await handleClientGoal(msg, session, text);
        break;
      case 'COLLECT_COACH_NAME':
        await handleCoachName(msg, session, text);
        break;
      case 'COLLECT_COACH_CITY':
        await handleCoachCity(msg, session, text);
        break;
      case 'COLLECT_COACH_SPEC':
        await handleCoachSpec(msg, session, text);
        break;
      case 'COLLECT_COACH_EXP':
        await handleCoachExp(msg, session, text);
        break;
      case 'BROWSING_PRODUCTS':
        await handleProductSelection(msg, session, lower);
        break;
      case 'ADDING_QUANTITY':
        await handleQuantity(msg, session, lower);
        break;
      case 'CONFIRM_CART_OR_MORE':
        await handleCartDecision(msg, session, lower);
        break;
      case 'COLLECT_NAME':
        await handleName(msg, session, text);
        break;
      case 'COLLECT_ADDRESS':
        await handleAddress(msg, session, text);
        break;
      case 'COLLECT_PINCODE':
        await handlePincode(msg, session, text);
        break;
      case 'CHOOSE_PAYMENT':
        await handlePaymentChoice(msg, session, lower);
        break;
      case 'CONFIRM_PAYMENT':
        await handlePaymentConfirmation(msg, session, lower);
        break;
      default:
        await resetSession(chatId);
        await sendMainMenu(msg);
    }
    await saveSession(chatId, session);
  } catch (err) {
    console.error('Error handling message:', err);
    await resetSession(chatId);
    await msg.reply('⚠️ Sorry, something went wrong. Type "menu" to start again.');
  }
}

// ---- FLOW FUNCTIONS (menu-based) ----
async function welcomeAndMenu(msg) {
  const session = await loadSession(msg.from);
  session.step = 'MAIN_MENU';
  await saveSession(msg.from, session);

  await msg.reply(
    `👋 *Welcome to ${BRAND_NAME}!*` + '\n\n' +
    'India\'s Most Trusted Coaching Platform for athletes and fitness enthusiasts.\n\n' +
    'How would you like to proceed?\n' +
    '1. I am a *Client* (Looking for coaching/services)\n' +
    '2. I am a *Coach* (Want to join/have queries)\n\n' +
    'Reply with 1 or 2.'
  );
}

async function handleRoleChoice(msg, session, lower) {
  if (lower === '1') {
    session.step = 'CLIENT_SERVICES';
    await msg.reply(
      '*Our World-Class Services*\n\n' +
      '• *Fitness*: Personal Training, Group Classes, Cardio Zones.\n' +
      '• *Physio*: Injury Rehab, Sports Massage, Pain Management.\n' +
      '• *Sports*: Professional coaching & Skill Development.\n' +
      '• *Yoga*: Hatha, Vinyasa, Meditation & Flexibility.\n' +
      '• *Online*: Virtual coaching with 24/7 app support.\n' +
      '• *Nutrition*: Custom Meal Plans & Dietary Analysis.\n\n' +
      '👉 *Book a Free Demo:* https://www.mrcoach.in/book-demo\n\n' +
      'To help you better, please tell us your name.'
    );
    session.step = 'COLLECT_CLIENT_NAME';
  } else if (lower === '2') {
    session.step = 'COLLECT_COACH_NAME';
    const promoPath = path.join(__dirname, 'WhatsApp Image 2026-03-23 at 6.34.53 PM (1).jpeg');
    const coachMsg = '🏋️ *Welcome to Mr.COACH FITNESS COMPANY*\n\n' +
      'Are you a *Certified Fitness Coach / Physiotherapist / Yoga Trainer / Sports Coach / Dietitian / Massage Therapist?*\n\n' +
      'If yes, please:\n\n' +
      '1️⃣ Download the Mr.Coach App – [ https://play.google.com/store/apps/details?id=com.mrcoach.pro ]\n\n' +
      '2️⃣ Join our Coaches WhatsApp Community – [ https://chat.whatsapp.com/F1cDrGmE8VhHNHbamTO0Me ]\n\n' +
      '3️⃣ Watch the Tutorial Videos on YouTube – [ https://youtu.be/awQgQpxhwc0?si=dCzObleqSY97JI1k ]\n\n' +
      '4️⃣ Start accessing client leads.\n\n' +
      'Reply with:👇\n\n' +
      'Name:\n' +
      'City:\n' +
      'Specialization:\n' +
      'Experience (Years):\n\n' +
      'Our Mr.Coach Team will guide you further. 💪📲';

    if (fs.existsSync(promoPath)) {
      const media = MessageMedia.fromFilePath(promoPath);
      await waClient.sendMessage(msg.from, media, { caption: coachMsg });
    } else {
      await msg.reply(coachMsg);
    }
  } else {
    await msg.reply('Please reply with 1 for Client or 2 for Coach.');
  }
}

async function handleClientName(msg, session, text) {
  if (!text || text.length < 2) {
    await msg.reply('Please enter your name.');
    return;
  }
  session.temp.clientName = text.trim();
  session.step = 'COLLECT_CLIENT_GENDER';
  await msg.reply(
    `Nice to meet you, *${session.temp.clientName}*!\n\n` +
    'Please select your *Gender*:\n' +
    '1. Male\n' +
    '2. Female\n' +
    '3. Other'
  );
}

async function handleClientGender(msg, session, lower) {
  if (lower === '1') session.temp.clientGender = 'Male';
  else if (lower === '2') session.temp.clientGender = 'Female';
  else if (lower === '3') session.temp.clientGender = 'Other';
  else {
    await msg.reply('Please reply with 1, 2, or 3 for Gender.');
    return;
  }

  session.step = 'COLLECT_CLIENT_LOCATION';
  await msg.reply('Great! Which city/location are you from?');
}

async function handleClientLocation(msg, session, text) {
  if (!text || text.length < 2) {
    await msg.reply('Please enter your location.');
    return;
  }
  session.temp.clientLocation = text.trim();
  session.step = 'COLLECT_CLIENT_GOAL';
  await msg.reply('What is your primary fitness goal? (e.g., Weight loss, Muscle gain, Sports performance)');
}

async function handleClientGoal(msg, session, text) {
  if (!text || text.length < 2) {
    await msg.reply('Please describe your goal.');
    return;
  }
  session.temp.clientGoal = text.trim();

  // Save Client Lead
  try {
    const phone = msg.from.replace('@c.us', '');
    await saveClientLead(msg.from, {
      name: session.temp.clientName,
      gender: session.temp.clientGender,
      phone: phone,
      location: session.temp.clientLocation,
      goal: session.temp.clientGoal
    });
  } catch (err) {
    console.error('Error saving client lead:', err);
  }

  await msg.reply('✅ *Details Received!*\n\nThank you for sharing your goals. To help us better understand your needs, please fill out our *Free Demo Form* on our website:\n\n👉 https://www.mrcoach.in/book-demo\n\nOur team will reach out to you shortly! 💪');
  await resetSession(msg.from);
}

async function handleCoachName(msg, session, text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // If user provided a multi-line blob (at least 3 lines), parse it all at once
  if (lines.length >= 3) {
    session.temp.coachName = lines[0].replace(/^(Name|Full Name)[\s:]*/i, '') || 'Unknown';
    session.temp.coachCity = lines[1].replace(/^(City|Location)[\s:]*/i, '') || '-';
    session.temp.coachSpec = lines[2].replace(/^(Specialization|Spec)[\s:]*/i, '') || '-';
    session.temp.coachExp = lines[3] ? lines[3].replace(/^(Experience|Exp)[ \w()]*[\s:]*/i, '') : '-';

    // Move directly to the final handling logic
    return await handleCoachExp(msg, session, session.temp.coachExp);
  }

  // Otherwise, proceed with step-by-step
  if (!text || text.length < 2) {
    await msg.reply('Please provide your full name:');
    return;
  }
  session.temp.coachName = text.trim();
  session.step = 'COLLECT_COACH_CITY';
  await saveSession(msg.from, session);
  await msg.reply(`Nice to meet you, ${session.temp.coachName}! Which *City* are you located in?`);
}

async function handleCoachCity(msg, session, text) {
  if (!text || text.length < 2) {
    await msg.reply('Please provide your city:');
    return;
  }
  session.temp.coachCity = text.trim();
  session.step = 'COLLECT_COACH_SPEC';
  await saveSession(msg.from, session);
  await msg.reply('What is your *Specialization*? (e.g., Fitness Coach, Yoga Trainer, Physio)');
}

async function handleCoachSpec(msg, session, text) {
  if (!text || text.length < 2) {
    await msg.reply('Please provide your specialization:');
    return;
  }
  session.temp.coachSpec = text.trim();
  session.step = 'COLLECT_COACH_EXP';
  await saveSession(msg.from, session);
  await msg.reply('How many years of *Experience* do you have?');
}

async function handleCoachExp(msg, session, text) {
  if (!text || text.length < 1) {
    await msg.reply('Please provide your years of experience:');
    return;
  }
  session.temp.coachExp = text.trim();

  // Save Coach Lead
  try {
    await saveCoachLead(msg.from, {
      name: session.temp.coachName,
      city: session.temp.coachCity,
      specialization: session.temp.coachSpec,
      experience: session.temp.coachExp
    });
  } catch (err) {
    console.error('Error saving coach lead:', err);
  }

  const imagePath = path.join(__dirname, 'coach_onboarding.jpeg');
  if (fs.existsSync(imagePath)) {
    const media = MessageMedia.fromFilePath(imagePath);
    await msg.reply(media, null, {
      caption:
        'Register on *MR.COACH PRO* in 4 Easy Steps\n\n' +
        '1) Download\n' +
        '2) Sign Up\n' +
        '3) Complete Profile\n' +
        '4) Start Getting Clients\n\n' +
        'Wishing you success with Mr.Coach Fitness Company\n\n' +
        'https://play.google.com/store/apps/details?id=com.mrcoach.pro'
    });
  } else {
    // Fallback if image is missing
    await msg.reply(
      'Register on *MR.COACH PRO* in 4 Easy Steps\n\n' +
      '1) Download: https://play.google.com/store/apps/details?id=com.mrcoach.pro\n' +
      '2) Sign Up\n' +
      '3) Complete Profile\n' +
      '4) Start Getting Clients\n\n' +
      'Wishing you success with Mr.Coach Fitness Company'
    );
  }

  await resetSession(msg.from);
}

async function handleOffersMenu(msg, session, lower) {
  if (lower === '1') {
    session.step = 'BROWSING_PRODUCTS';
    await showProducts(msg);
  } else if (lower === '2') {
    session.step = 'MAIN_MENU';
    await sendMainMenu(msg);
  } else {
    await msg.reply('Reply 1 to see products or 2 to go back to main menu.');
  }
}

async function showProducts(msg) {
  const products = await fetchProducts();
  if (!products.length) {
    await msg.reply('Currently no programs are available. Please try again later.');
    return;
  }
  let text = '*Available Programs*\n\n';
  products.forEach((p, idx) => {
    text += `${idx + 1}. *${p.name}* (${p.id}) – ₹${p.price}\n`;
  });
  text += '\nReply with the number (1, 2, 3, ...).';

  await msg.reply(text);
  const session = await loadSession(msg.from);
  session.step = 'BROWSING_PRODUCTS';
  session.temp.productList = products;
  await saveSession(msg.from, session);
}

async function handleProductSelection(msg, session, lower) {
  const products = session.temp.productList || await fetchProducts();
  const idx = parseInt(lower, 10) - 1;

  if (isNaN(idx) || idx < 0 || idx >= products.length) {
    await msg.reply('Please reply with a valid number from the list.');
    await showProducts(msg);
    return;
  }

  const chosen = products[idx];
  session.temp.selectedProduct = chosen;
  session.step = 'ADDING_QUANTITY';

  await msg.reply(
    `You chose *${chosen.name}* (₹${chosen.price} per piece).\n\n` +
    'Choose quantity:\n' +
    '1. 10 pcs\n' +
    '2. 25 pcs\n' +
    '3. 50 pcs\n' +
    '4. Custom quantity (type your own number)'
  );
}

async function handleQuantity(msg, session, lower) {
  let qty;
  if (lower === '1') qty = 1;
  else if (lower === '2') qty = 3;
  else if (lower === '3') qty = 6;
  else {
    qty = parseInt(lower, 10);
    if (isNaN(qty) || qty <= 0) {
      await msg.reply('Please choose 1, 2, 3 or type a valid number for months.');
      return;
    }
  }

  const product = session.temp.selectedProduct;
  const lineTotal = product.price * qty;

  session.cart.push({
    productId: product.id,
    name: product.name,
    qty,
    price: product.price,
    lineTotal
  });

  session.temp.selectedProduct = null;
  session.step = 'CONFIRM_CART_OR_MORE';

  let cartText = '*Summary*\n\n';
  let total = 0;
  for (const item of session.cart) {
    total += item.lineTotal;
    cartText += `${item.name} (${item.qty} Months) = ₹${item.lineTotal}\n`;
  }
  cartText += `\n*Total:* ₹${total}\n\n`;
  cartText +=
    'What next?\n' +
    '1. Add more programs\n' +
    '2. Proceed to enrollment\n' +
    '3. Cancel\n\n' +
    'Reply with 1, 2, or 3.';

  await msg.reply(cartText);
}

async function handleCartDecision(msg, session, lower) {
  if (lower === '1') {
    session.step = 'BROWSING_PRODUCTS';
    await showProducts(msg);
  } else if (lower === '2') {
    if (!session.cart.length) {
      await msg.reply('Your cart is empty. Type "menu" to start again.');
      await resetSession(msg.from);
      return;
    }
    session.step = 'COLLECT_NAME';
    await msg.reply('Please type your *full name* for enrollment.');
  } else if (lower === '3') {
    await msg.reply('Order cancelled. Type "menu" to start again anytime.');
    await resetSession(msg.from);
  } else {
    await msg.reply('Please reply with 1 to add more, 2 to checkout, or 3 to cancel.');
  }
}

async function handleName(msg, session, text) {
  if (!text || text.length < 2) {
    await msg.reply('Please enter a valid name.');
    return;
  }
  session.temp.name = text.trim();
  session.step = 'COLLECT_ADDRESS';
  await msg.reply('Please type your *full delivery address* (door no, street, area, city).');
}

async function handleAddress(msg, session, text) {
  if (!text || text.length < 5) {
    await msg.reply('Please enter a bit more detailed address.');
    return;
  }
  session.temp.address = text.trim();
  session.step = 'COLLECT_PINCODE';
  await msg.reply('Please type your *pincode* (numbers only).');
}

async function handlePincode(msg, session, text) {
  const pin = text.replace(/\D/g, '');
  if (pin.length < 4) {
    await msg.reply('Please enter a valid pincode.');
    return;
  }
  session.temp.pincode = pin;
  session.step = 'CHOOSE_PAYMENT';

  let total = 0;
  for (const item of session.cart) total += item.lineTotal;

  await msg.reply(
    `*Order Summary*\n` +
    `Name: ${session.temp.name}\n` +
    `Address: ${session.temp.address}\n` +
    `Pincode: ${session.temp.pincode}\n\n` +
    `Items: ${session.cart.length}\n` +
    `Total: ₹${total}\n\n` +
    'Choose payment method:\n' +
    '1️⃣ UPI / Payment Link\n' +
    '2️⃣ Bank transfer\n\n' +
    'Reply with 1 or 2.'
  );
}

async function handlePaymentChoice(msg, session, lower) {
  if (lower === '1') {
    session.temp.paymentMethod = 'UPI_LINK';
  } else if (lower === '2') {
    session.temp.paymentMethod = 'BANK_TRANSFER';
  } else {
    await msg.reply('Reply 1 for UPI/Payment Link or 2 for Bank Transfer.');
    return;
  }

  let total = 0;
  for (const item of session.cart) total += item.lineTotal;

  session.step = 'CONFIRM_PAYMENT';
  await msg.reply(
    `You chose *${session.temp.paymentMethod === 'UPI_LINK' ? 'UPI / Payment Link' : 'Bank Transfer'}*.\n` +
    `Your payable amount will be around *₹${total}*.\n\n` +
    'Reply *confirm* to get payment details or *cancel* to cancel this order.'
  );
}

async function handlePaymentConfirmation(msg, session, lower) {
  if (lower !== 'confirm') {
    await msg.reply('Order not confirmed. Type "confirm" to proceed or "cancel" to cancel.');
    return;
  }

  let total = 0;
  for (const item of session.cart) total += item.lineTotal;

  const phoneRaw = msg.from.replace('@c.us', '');
  const orderData = {
    items: session.cart,
    total,
    paymentMethod: session.temp.paymentMethod,
    address: session.temp.address,
    pincode: session.temp.pincode,
    name: session.temp.name,
    phone: phoneRaw
  };

  const { order, orderCode } = await createOrder(orderData, msg.from);

  if (order.payment_method === 'UPI_LINK') {
    const link = await createPaymentLink(orderData, orderCode);
    await msg.reply(
      '*Payment Link (UPI / Card / Netbanking)*\n\n' +
      `Order ID: ${orderCode}\n` +
      `Amount: ₹${order.total}\n` +
      `Pay here: ${link}\n\n` +
      'After payment, reply "paid" with a screenshot for faster confirmation.'
    );
  } else {
    await msg.reply(
      '*Bank Transfer Details*\n\n' +
      `Order ID: ${orderCode}\n` +
      `Account Name: ${BRAND_NAME}\n` +
      `Bank: ${BANK_NAME}\n` +
      `A/C No: ${BANK_ACC_NO}\n` +
      `IFSC: ${BANK_IFSC}\n` +
      `Amount: ₹${order.total}\n\n` +
      'After transfer, reply "paid" with transaction reference.'
    );
  }

  await resetSession(msg.from);
}

// ---- ADMIN ROUTES ----
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body || {};
  const token = await login(email, password);
  if (!token) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token });
});

app.get('/api/status', authMiddleware, (req, res) => {
  res.json({ status: botStatus, hasClient: !!waClient });
});

app.get('/api/orders', authMiddleware, async (req, res) => {
  const orders = await getRecentOrders(50);
  res.json({ orders });
});

// Update order status + tracking + invoice + notify
app.post('/api/orders/update-status', authMiddleware, async (req, res) => {
  try {
    const { orderCode, status, trackingCode, notify } = req.body || {};
    if (!orderCode || !status) {
      return res.status(400).json({ error: 'orderCode and status are required' });
    }

    const orderRow = await get(
      `SELECT o.*, c.wa_id, c.phone as customer_phone
       FROM orders o
       JOIN customers c ON o.customer_id = c.id
       WHERE o.order_code = ?`,
      [orderCode]
    );
    if (!orderRow) {
      return res.status(404).json({ error: 'Order not found' });
    }

    await run(
      'UPDATE orders SET status = ?, tracking_code = ? WHERE order_code = ?',
      [status, trackingCode || null, orderCode]
    );

    const updated = await get(
      `SELECT o.*, c.wa_id, c.phone as customer_phone
       FROM orders o
       JOIN customers c ON o.customer_id = c.id
       WHERE o.order_code = ?`,
      [orderCode]
    );

    // Invoice generation + send when CONFIRMED
    if (status === 'CONFIRMED') {
      const invoiceNo = updated.invoice_no || `INV-${updated.id}`;
      let invoicePath = updated.invoice_pdf
        ? path.join(__dirname, updated.invoice_pdf.replace('/invoices/', 'invoices/'))
        : null;

      if (!invoicePath || !fs.existsSync(invoicePath)) {
        try {
          invoicePath = await generateInvoicePdf(orderCode, invoiceNo);
          const relPath = '/invoices/' + path.basename(invoicePath);
          await run(
            'UPDATE orders SET invoice_no = ?, invoice_pdf = ? WHERE order_code = ?',
            [invoiceNo, relPath, orderCode]
          );
          updated.invoice_no = invoiceNo;
          updated.invoice_pdf = relPath;
        } catch (e) {
          console.error('Invoice generation failed:', e);
        }
      }

      if (invoicePath && waClient && botStatus === 'CONNECTED') {
        try {
          const pdfBuffer = fs.readFileSync(invoicePath);
          const base64 = pdfBuffer.toString('base64');
          const media = new MessageMedia('application/pdf', base64, `${orderCode}.pdf`);
          const chatId = updated.wa_id || (updated.customer_phone + '@c.us');
          await waClient.sendMessage(chatId, media);
        } catch (e) {
          console.error('Failed to send invoice PDF:', e);
        }
      }
    }

    // Status text notification
    if (notify && waClient && botStatus === 'CONNECTED') {
      const chatId = updated.wa_id || (updated.customer_phone + '@c.us');
      let msgText =
        `*${BRAND_NAME} – Order Update*\n\n` +
        `Order ID: ${updated.order_code}\n` +
        `Status: ${updated.status}\n`;

      if (trackingCode) {
        msgText += `Tracking ID: ${trackingCode}\n`;
      }

      msgText += '\nThank you for choosing MRCoach Fitness!';

      try {
        await waClient.sendMessage(chatId, msgText);
      } catch (e) {
        console.error('Failed to send WhatsApp notification:', e);
      }
    }

    res.json({ ok: true, order: updated });
  } catch (err) {
    console.error('Update status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Status API
app.get('/api/status', authMiddleware, (req, res) => {
  res.json({
    status: botStatus,
    lastActive: lastBotActivity ? lastBotActivity.toISOString() : null
  });
});

// Leads API
app.get('/api/leads/clients', authMiddleware, async (req, res) => {
  try {
    const leads = await getClientLeads();
    res.json({ ok: true, leads });
  } catch (err) {
    console.error('Fetch client leads error:', err);
    res.status(500).json({ error: 'Failed to fetch client leads' });
  }
});

app.get('/api/leads/coaches', authMiddleware, async (req, res) => {
  try {
    const leads = await getCoachLeads();
    res.json({ ok: true, leads });
  } catch (err) {
    console.error('Fetch coach leads error:', err);
    res.status(500).json({ error: 'Failed to fetch coach leads' });
  }
});

app.post('/api/leads/clients/update-status', authMiddleware, async (req, res) => {
  try {
    const { id, status } = req.body;
    await updateClientStatus(id, status);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update client status' });
  }
});

app.post('/api/leads/coaches/update-status', authMiddleware, async (req, res) => {
  try {
    const { id, status } = req.body;
    await updateCoachStatus(id, status);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update coach status' });
  }
});

// Reports API (Summary Stats)
app.get('/api/reports/summary', authMiddleware, async (req, res) => {
  try {
    const stats = await getLeadStats();
    res.json({ ok: true, stats });
  } catch (err) {
    console.error('Reports error:', err);
    res.status(500).json({ error: 'Failed to load reports' });
  }
});

// Product sync from website
app.post('/api/products/sync', authMiddleware, async (req, res) => {
  try {
    const count = await syncProductsFromWebsite();
    res.json({ ok: true, count });
  } catch (e) {
    console.error('Product sync failed:', e);
    res.status(500).json({ error: 'Failed to sync products' });
  }
});

app.post('/api/start', authMiddleware, async (req, res) => {
  await startBot();
  res.json({ ok: true, status: botStatus });
});

app.post('/api/stop', authMiddleware, async (req, res) => {
  await stopBot();
  res.json({ ok: true, status: botStatus });
});

// ---- INIT EVERYTHING ----
(async () => {
  try {
    await init();
    await ensureAdminUser();

    app.listen(PORT, () => {
      console.log(`HTTP dashboard listening on http://localhost:${PORT}/admin`);
    });

    startBot();
  } catch (err) {
    console.error('Fatal init error:', err);
    process.exit(1);
  }
})();
