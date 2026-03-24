const db = require('./db');

(async () => {
    try {
        const products = await db.all('SELECT * FROM products');
        console.log('--- AVAILABLE PROGRAMS ---');
        products.forEach(p => {
            console.log(`[${p.id}] ${p.name} - ₹${p.price}`);
        });
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
