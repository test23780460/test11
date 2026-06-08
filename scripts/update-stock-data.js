const fs = require('fs');
const https = require('https');
const path = require('path');

const SYMBOLS = ['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','NFLX','JPM','V','XOM','SPY','QQQ','DIA','IWM','XLK','XLF'];

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 StockDipWatcher/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(String(res.statusCode)));
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function normalize(raw) {
  const q = raw.chart && raw.chart.result && raw.chart.result[0];
  if (!q) return null;
  const meta = q.meta || {};
  const quote = (q.indicators && q.indicators.quote && q.indicators.quote[0]) || {};
  const closes = (quote.close || []).filter(Number.isFinite);
  if (!closes.length) return null;
  const price = meta.regularMarketPrice || closes[closes.length - 1];
  const prev = meta.chartPreviousClose || closes[0];
  const high = Math.max(...closes);
  const low = Math.min(...closes);
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(0, d));
    losses.push(Math.max(0, -d));
  }
  const ag = gains.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const al = losses.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const rsi = al ? 100 - (100 / (1 + ag / al)) : 70;
  const avg = closes.reduce((a, b) => a + b, 0) / closes.length;
  return { symbol: meta.symbol, name: meta.longName || meta.shortName || meta.symbol, price, change: price - prev, changePct: ((price - prev) / prev) * 100, rsi, avg, belowHigh: ((high - price) / high) * 100, aboveLow: ((price - low) / low) * 100, volume: meta.regularMarketVolume || 0, closes };
}

async function main() {
  const records = [];
  for (const symbol of SYMBOLS) {
    try {
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`;
      const row = normalize(await getJson(url));
      if (row) records.push(row);
      await new Promise(r => setTimeout(r, 350));
    } catch (err) {
      console.warn(`Skipping ${symbol}: ${err.message}`);
    }
  }
  const out = { updatedAt: new Date().toISOString(), records };
  const root = path.join(__dirname, '..');
  fs.writeFileSync(path.join(root, 'prices.json'), JSON.stringify(out, null, 2));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'market.json'), JSON.stringify(out, null, 2));
  const csv = ['symbol,name,price,changePct,rsi,belowHigh,aboveLow,volume'].concat(records.map(r => [r.symbol, JSON.stringify(r.name || ''), r.price, r.changePct, r.rsi, r.belowHigh, r.aboveLow, r.volume].join(','))).join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'prices.csv'), csv);
  fs.writeFileSync(path.join(root, 'data', 'market.csv'), csv);
  console.log(`Wrote ${records.length} stock records`);
}

main().catch(err => { console.error(err); process.exit(1); });
