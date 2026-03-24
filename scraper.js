// scraper.js
const axios = require('axios');
const cheerio = require('cheerio'); // if you already use it
// const db = require('./db'); // whatever you use to save products

const SHOP_URL = 'https://mrcoach.fit/programs';

async function fetchWithRetry(url, retries = 3, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(url);
    } catch (err) {
      if (err.code === 'EAI_AGAIN' && i < retries - 1) {
        console.warn(`DNS error (${err.code}), retry ${i + 1}/${retries} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

/**
 * Sync programs from mrcoach.fit to your local DB.
 * Call this from index.js on startup or on a schedule.
 */
async function syncProductsFromWebsite() {
  console.log('Starting product sync from website...');

  // 1. Fetch HTML with retry logic
  const response = await fetchWithRetry(SHOP_URL);
  const html = response.data;

  // 2. Parse HTML (adapt selectors to match your existing code)
  const $ = cheerio.load(html);

  const products = [];

  $('.product-card').each((_, el) => {
    const name = $(el).find('.product-title').text().trim();
    const priceText = $(el).find('.product-price').text().trim();
    const imageUrl = $(el).find('img').attr('src');
    const sku = $(el).attr('data-sku') || null;

    if (!name) return;

    const price = parseFloat(priceText.replace(/[^\d.]/g, ''));

    products.push({
      name,
      price,
      imageUrl,
      sku,
    });
  });

  console.log(`Parsed ${products.length} products from website`);

  // 3. Save/update products in your DB (replace with your real logic)
  /*
  for (const p of products) {
    await db.upsertProduct(p); // whatever function you already use
  }
  */

  console.log('Product sync finished.');
}

module.exports = {
  syncProductsFromWebsite,
};
