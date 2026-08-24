const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  console.log('Navigating to stake.com...');
  try {
    await page.goto('https://stake.com/sportsbook', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 10000));

    const title = await page.title();
    console.log('Title:', title);

    // Wait longer if Cloudflare challenge
    if (title.includes('moment') || title.includes('challenge')) {
      console.log('Cloudflare detected, waiting...');
      await new Promise(r => setTimeout(r, 20000));
    }

    // Extract all text from the sportsbook
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 15000) || '');

    fs.writeFileSync('stake-odds.json', JSON.stringify({
      scrapedAt: new Date().toISOString(),
      pageTitle: title,
      content: text,
      events: []
    }, null, 2));
    console.log('Saved. Content length:', text.length);

  } catch (err) {
    console.error('Error:', err.message);
    fs.writeFileSync('stake-odds.json', JSON.stringify({ error: err.message, events: [] }));
  }

  await browser.close();
})();
