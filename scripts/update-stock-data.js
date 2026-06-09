const fs = require('fs');
const https = require('https');
const path = require('path');

const STOCK_SYMBOLS = [
  'AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','NFLX','JPM','V','XOM','SPY','QQQ','DIA','IWM','XLK','XLF',
  'PLTR','SOFI','COIN','HOOD','RIVN','LCID','F','GM','BAC','WFC','GS','MS','PYPL','SQ','SHOP','CRM','ORCL','AVGO','MU','INTC',
  'TSM','ASML','QCOM','ARM','SMCI','NOW','UBER','ABNB','DIS','WMT','COST','HD','LOW','NKE','SBUX','MCD','PEP','KO','TGT',
  'CVX','OXY','SLB','UNH','LLY','NVO','PFE','MRK','JNJ','ABBV','BA','CAT','GE','LMT','RTX','NOC','DE','BABA','PDD','SNOW',
  'DDOG','PANW','CRWD','NET','ROKU','PINS','ADBE','AMAT','LRCX','KLAC','TXN','ADI','MRVL','CDNS','SNPS','WDAY','TEAM','ZS',
  'OKTA','MDB','FSLR','ENPH','NEE','DUK','SO','T','VZ','CMCSA','TMUS','AXP','MA','BLK','SCHW','C','TFC','USB','CB','PGR',
  'WFC','BK','AMGN','GILD','BMY','REGN','ISRG','TMO','DHR','ELV','CI','CVS','MDT','SYK','HON','UPS','FDX','DAL','UAL',
  'AAL','LUV','CARR','ETN','EMR','MMM','WM','LIN','APD','FCX','NEM','EOG','COP','MPC','PSX','HAL','BKR','WMB','KMI',
  'PG','CL','KMB','PM','MO','MDLZ','GIS','KR','DG','DLTR','TJX','ROST','BKNG','MAR','HLT','CMG','YUM','EL','LULU'
];

const CRYPTO_SYMBOLS = [
  'BTC-USD','ETH-USD','SOL-USD','XRP-USD','BNB-USD','DOGE-USD','ADA-USD','AVAX-USD','LINK-USD','DOT-USD','LTC-USD','BCH-USD'
];

const SYMBOLS = [...new Set([...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS])];
const MAX_HISTORY_ROWS = 5000;
const MAX_RUNS = 300;

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
  const rawCloses = quote.close || [];
  const rawTimes = q.timestamp || [];
  const points = rawCloses.map((close, i) => ({ close, time: rawTimes[i] })).filter(p => Number.isFinite(p.close));
  const closes = points.map(p => p.close);
  const times = points.map(p => p.time ? new Date(p.time * 1000).toISOString() : null);
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
  return {
    symbol: meta.symbol,
    assetType: /-USD$/.test(meta.symbol || '') ? 'crypto' : 'stock',
    name: meta.longName || meta.shortName || meta.symbol,
    price,
    change: price - prev,
    changePct: ((price - prev) / prev) * 100,
    rsi,
    avg,
    belowHigh: ((high - price) / high) * 100,
    aboveLow: ((price - low) / low) * 100,
    volume: meta.regularMarketVolume || 0,
    closes,
    times
  };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function top(records, sortFn, limit = 5) {
  return [...records].sort(sortFn).slice(0, limit).map(r => ({
    symbol: r.symbol,
    assetType: r.assetType,
    price: r.price,
    changePct: r.changePct,
    rsi: r.rsi
  }));
}

function avg(records, field) {
  return records.length ? records.reduce((sum, r) => sum + (Number(r[field]) || 0), 0) / records.length : 0;
}

function writeHistory(root, timestamp, records) {
  const dataDir = path.join(root, 'data');
  const csvPath = path.join(dataDir, 'history.csv');
  const jsonPath = path.join(dataDir, 'history.json');
  const csvHeader = 'timestamp,symbol,assetType,price,changePct,rsi,belowHigh,aboveLow,volume';
  const oldRows = fs.existsSync(csvPath)
    ? fs.readFileSync(csvPath, 'utf8').trim().split('\n').filter(Boolean).slice(1)
    : [];
  const newRows = records.map(r => [timestamp, r.symbol, r.assetType, r.price, r.changePct, r.rsi, r.belowHigh, r.aboveLow, r.volume].join(','));
  const rows = oldRows.concat(newRows).slice(-MAX_HISTORY_ROWS);
  fs.writeFileSync(csvPath, [csvHeader, ...rows].join('\n') + '\n');

  const old = readJson(jsonPath, { runs: [] });
  const stockRecords = records.filter(r => r.assetType === 'stock');
  const cryptoRecords = records.filter(r => r.assetType === 'crypto');
  const run = {
    timestamp,
    totalRecords: records.length,
    stockRecords: stockRecords.length,
    cryptoRecords: cryptoRecords.length,
    stockAverageMove: avg(stockRecords, 'changePct'),
    cryptoAverageMove: avg(cryptoRecords, 'changePct'),
    advancers: records.filter(r => r.changePct >= 0).length,
    decliners: records.filter(r => r.changePct < 0).length,
    topGainers: top(records, (a, b) => b.changePct - a.changePct),
    topLosers: top(records, (a, b) => a.changePct - b.changePct),
    cryptoGainers: top(cryptoRecords, (a, b) => b.changePct - a.changePct),
    cryptoLosers: top(cryptoRecords, (a, b) => a.changePct - b.changePct)
  };
  const out = { updatedAt: timestamp, maxHistoryRows: MAX_HISTORY_ROWS, runs: [run, ...(old.runs || [])].slice(0, MAX_RUNS) };
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));
}

async function main() {
  const records = [];
  for (const symbol of SYMBOLS) {
    try {
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`;
      const row = normalize(await getJson(url));
      if (row) records.push(row);
      await new Promise(r => setTimeout(r, 180));
    } catch (err) {
      console.warn(`Skipping ${symbol}: ${err.message}`);
    }
  }
  const timestamp = new Date().toISOString();
  const out = { updatedAt: timestamp, scannerSize: STOCK_SYMBOLS.length, cryptoSize: CRYPTO_SYMBOLS.length, records };
  const root = path.join(__dirname, '..');
  fs.writeFileSync(path.join(root, 'prices.json'), JSON.stringify(out, null, 2));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'market.json'), JSON.stringify(out, null, 2));
  const csv = ['symbol,assetType,name,price,changePct,rsi,belowHigh,aboveLow,volume'].concat(records.map(r => [r.symbol, r.assetType, JSON.stringify(r.name || ''), r.price, r.changePct, r.rsi, r.belowHigh, r.aboveLow, r.volume].join(','))).join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'prices.csv'), csv);
  fs.writeFileSync(path.join(root, 'data', 'market.csv'), csv);
  writeHistory(root, timestamp, records);
  console.log(`Wrote ${records.length} records and logged history snapshot at ${timestamp}`);
}

main().catch(err => { console.error(err); process.exit(1); });
