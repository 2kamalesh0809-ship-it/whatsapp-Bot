// invoice.js
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { get, all } = require('./db');

const BRAND_NAME = process.env.BRAND_NAME || 'MRCoach Fitness';
const GSTIN = process.env.GSTIN || '33ABCDE1234F1Z5';
const PAN = process.env.PAN || 'ABCDE1234F';
const ADDRESS_LINE = process.env.ADDRESS_LINE || 'Chennai, Tamil Nadu';
const MOBILE = process.env.MOBILE || '+91-9876543210';
const BANK_NAME = process.env.BANK_NAME || 'MRCoach Bank';
const BANK_ACC_NO = process.env.BANK_ACC_NO || '1234567890';
const BANK_IFSC = process.env.BANK_IFSC || 'MRCH0001234';

async function getOrderFull(orderCode) {
  const order = await get(
    `SELECT o.*, c.name as customer_name, c.phone as customer_phone, c.wa_id
     FROM orders o
     JOIN customers c ON o.customer_id = c.id
     WHERE o.order_code = ?`,
    [orderCode]
  );
  if (!order) return null;
  const items = await all('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
  return { order, items };
}

function invoiceHtml(order, items, invoiceNo) {
  const dateStr = order.created_at ? order.created_at.split(' ')[0] : '';
  const total = order.total;
  const taxable = total / 1.18;
  const cgst = taxable * 0.09;
  const sgst = taxable * 0.09;

  const rowsHtml = items.map((it, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td>${it.name}</td>
      <td>6115</td>
      <td>${it.qty}</td>
      <td>${taxable.toFixed(2)}</td>
      <td>9.00%</td>
      <td>${cgst.toFixed(2)}</td>
      <td>9.00%</td>
      <td>${sgst.toFixed(2)}</td>
      <td>${total.toFixed(2)}</td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Invoice ${invoiceNo}</title>
<style>
body { font-family: Arial, sans-serif; font-size: 10px; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid #000; padding: 3px; }
h1,h2,h3,h4,h5 { margin: 0; padding: 0; }
.small { font-size: 9px; }
</style>
</head>
<body>
  <div style="text-align:center;">
    <h2>${BRAND_NAME.toUpperCase()}</h2>
    <div>${ADDRESS_LINE}</div>
    <div>Mobile: ${MOBILE}</div>
    <div><b>GSTIN:</b> ${GSTIN} | <b>PAN:</b> ${PAN}</div>
    <h3 style="margin-top:8px;">TAX INVOICE</h3>
  </div>

  <table style="margin-top:8px;">
    <tr>
      <td style="width:33%; vertical-align:top;">
        <b>Sold By</b><br>
        ${BRAND_NAME}<br>
        ${ADDRESS_LINE}<br>
        GSTIN: ${GSTIN}
      </td>
      <td style="width:33%; vertical-align:top;">
        <b>Bill To</b><br>
        ${order.customer_name || ''}<br>
        ${order.address || ''}<br>
        PIN: ${order.pincode || ''}<br>
        Mobile: ${order.customer_phone || ''}
      </td>
      <td style="width:33%; vertical-align:top;">
        <b>Ship To</b><br>
        ${order.customer_name || ''}<br>
        ${order.address || ''}<br>
        PIN: ${order.pincode || ''}<br>
        Mobile: ${order.customer_phone || ''}
      </td>
    </tr>
  </table>

  <table style="margin-top:6px;">
    <tr>
      <td>Invoice No: ${invoiceNo}</td>
      <td>Order ID: ${order.order_code}</td>
      <td>Date: ${dateStr}</td>
    </tr>
  </table>

  <table style="margin-top:6px;">
    <tr>
      <th>Sr.</th>
      <th>Product Description</th>
      <th>HSN</th>
      <th>Qty</th>
      <th>Taxable (₹)</th>
      <th>CGST</th>
      <th>CGST (₹)</th>
      <th>SGST</th>
      <th>SGST (₹)</th>
      <th>Amount (₹)</th>
    </tr>
    ${rowsHtml}
  </table>

  <table style="margin-top:6px;">
    <tr>
      <td style="width:50%; vertical-align:top;">
        <b>Total Taxable:</b> ₹${taxable.toFixed(2)}<br>
        <b>CGST Total:</b> ₹${cgst.toFixed(2)}<br>
        <b>SGST Total:</b> ₹${sgst.toFixed(2)}<br>
        <b>Invoice Total:</b> ₹${total.toFixed(2)}
      </td>
      <td style="width:50%; vertical-align:top;">
        <b>Terms &amp; Conditions:</b><br>
        1. Goods once sold will not be taken back or exchanged.<br>
        2. All disputes subject to Madurai jurisdiction only.<br>
        3. Interest @ 18% p.a. will be charged on overdue payments.<br>
        4. This is a computer generated invoice.
      </td>
    </tr>
  </table>

  <div style="margin-top:6px;">
    <b>Bank Details:</b><br>
    Account Name: ${BRAND_NAME}<br>
    Bank: ${BANK_NAME}<br>
    A/C No: ${BANK_ACC_NO}<br>
    IFSC: ${BANK_IFSC}
  </div>
</body>
</html>`;
}

async function generateInvoicePdf(orderCode, invoiceNo) {
  const data = await getOrderFull(orderCode);

  if (!data) throw new Error('Order not found');
  const { order, items } = data;

  const html = invoiceHtml(order, items, invoiceNo);
  const invoicesDir = path.join(__dirname, 'invoices');
  if (!fs.existsSync(invoicesDir)) fs.mkdirSync(invoicesDir);

  const filePath = path.join(invoicesDir, `${orderCode}.pdf`);

  //const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.pdf({ path: filePath, format: 'A4', printBackground: true });
  await browser.close();

  return filePath;
}

module.exports = {
  generateInvoicePdf
};
