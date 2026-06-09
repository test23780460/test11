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
const ALERT_COOLDOWN_HOURS = 6;
const ALERT_REPEAT_COUNT = 5;
const ALERT_SCORE_MIN = 92;

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

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      res.resume();
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300) ? resolve() : reject(new Error(`Discord ${res.statusCode}`)));
    });
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
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

function avg(records, field) {
  return records.length ? records.reduce((sum, r) => sum + (Number(r[field]) || 0), 0) / records.length : 0;
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function isCrypto(symbol) { return /-USD$/.test(symbol || ''); }
function fmt(n) { return Number.isFinite(n) ? `$${n.toFixed(Math.abs(n) < 10 ? 3 : 2)}` : '--'; }
function pct(n) { return Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '--'; }

function levels(r) {
  const p = r.closes || [];
  const hi = Math.max(...p);
  const lo = Math.min(...p);
  const avgPrice = p.reduce((a, b) => a + b, 0) / Math.max(1, p.length);
  const vol = Math.sqrt(p.reduce((a, b) => a + Math.pow(b - avgPrice, 2), 0) / Math.max(1, p.length)) || Math.max(.01, r.price * .01);
  return { trigger: Math.min(hi, r.price + vol * .65), stop: Math.max(.0001, lo - vol * .45), target: Math.min(hi + vol * .5, r.price + vol * 1.4), dipZone: Math.max(lo, r.price - vol * .8), avg: avgPrice };
}

function signal(r) {
  const l = levels(r);
  const c = isCrypto(r.symbol);
  if (r.rsi < (c ? 38 : 35) || r.changePct < (c ? -5 : -4)) return 'dip';
  if (r.rsi > (c ? 72 : 68) || (r.changePct > (c ? 5 : 1) && r.belowHigh < (c ? 1.5 : 1))) return 'peak';
  if (r.changePct > (c ? 2 : 1) || (r.price > l.avg && r.rsi > (c ? 55 : 52))) return 'momentum';
  return 'watch';
}

function aiScore(r) {
  const s = signal(r);
  const c = isCrypto(r.symbol);
  let n = c ? 48 : 50;
  if (s === 'dip') n += 18;
  if (s === 'momentum') n += 12;
  if (s === 'peak') n -= 2;
  n += clamp((45 - r.rsi) * (c ? .9 : 1.05), -22, 24);
  n += clamp(r.belowHigh * (c ? 1.4 : 2.1), 0, 22);
  n += clamp(-r.changePct * (c ? 1.1 : 1.8), -18, 18);
  if (!c && r.volume > 40000000) n += 6;
  return clamp(Math.round(n), 1, 99);
}

function confidence(r) {
  const p = r.closes || [];
  const range = Math.max(...p) - Math.min(...p);
  const vol = range / (r.price || 1) * 100;
  const c = isCrypto(r.symbol);
  let v = c ? 58 : 62;
  if (p.length > 50) v += 10;
  if (!c && r.volume > 30000000) v += 10;
  if (c && r.volume) v += 4;
  if (vol > (c ? 7 : 4)) v -= 8;
  if (Math.abs(r.changePct) > (c ? 12 : 8)) v -= 7;
  return clamp(Math.round(v), 20, 96);
}

function isSuperGoodDip(r) {
  return signal(r) === 'dip' && aiScore(r) >= ALERT_SCORE_MIN && confidence(r) >= 70 && r.rsi <= 38 && r.changePct <= -3;
}

function top(records, sortFn, limit = 5) {
  return [...records].sort(sortFn).slice(0, limit).map(r => ({ symbol: r.symbol, assetType: r.assetType, price: r.price, changePct: r.changePct, rsi: r.rsi }));
}

function writeHistory(root, timestamp, records) {
  const dataDir = path.join(root, 'data');
  const csvPath = path.join(dataDir, 'history.csv');
  const jsonPath = path.join(dataDir, 'history.json');
  const csvHeader = 'timestamp,symbol,assetType,price,changePct,rsi,belowHigh,aboveLow,volume';
  const oldRows = fs.existsSync(csvPath) ? fs.readFileSync(csvPath, 'utf8').trim().split('\n').filter(Boolean).slice(1) : [];
  const newRows = records.map(r => [timestamp, r.symbol, r.assetType, r.price, r.changePct, r.rsi, r.belowHigh, r.aboveLow, r.volume].join(','));
  fs.writeFileSync(csvPath, [csvHeader, ...oldRows.concat(newRows).slice(-MAX_HISTORY_ROWS)].join('\n') + '\n');

  const old = readJson(jsonPath, { runs: [] });
  const stockRecords = records.filter(r => r.assetType === 'stock');
  const cryptoRecords = records.filter(r => r.assetType === 'crypto');
  const run = { timestamp, totalRecords: records.length, stockRecords: stockRecords.length, cryptoRecords: cryptoRecords.length, stockAverageMove: avg(stockRecords, 'changePct'), cryptoAverageMove: avg(cryptoRecords, 'changePct'), advancers: records.filter(r => r.changePct >= 0).length, decliners: records.filter(r => r.changePct < 0).length, topGainers: top(records, (a, b) => b.changePct - a.changePct), topLosers: top(records, (a, b) => a.changePct - b.changePct), cryptoGainers: top(cryptoRecords, (a, b) => b.changePct - a.changePct), cryptoLosers: top(cryptoRecords, (a, b) => a.changePct - b.changePct) };
  fs.writeFileSync(jsonPath, JSON.stringify({ updatedAt: timestamp, maxHistoryRows: MAX_HISTORY_ROWS, runs: [run, ...(old.runs || [])].slice(0, MAX_RUNS) }, null, 2));
}

async function sendDiscordAlerts(root, timestamp, records) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  const alertsPath = path.join(root, 'data', 'alerts.json');
  const state = readJson(alertsPath, { updatedAt: null, sent: {} });
  const cooldownMs = ALERT_COOLDOWN_HOURS * 60 * 60 * 1000;
  const nowMs = new Date(timestamp).getTime();
  const candidates = records.filter(isSuperGoodDip).sort((a, b) => aiScore(b) - aiScore(a)).slice(0, 3);
  const fired = [];

  for (const r of candidates) {
    const last = state.sent[r.symbol] ? new Date(state.sent[r.symbol]).getTime() : 0;
    if (nowMs - last < cooldownMs) continue;
    const l = levels(r);
    const message = `SUPER DIP ALERT ${r.symbol}: AI ${aiScore(r)}/99, confidence ${confidence(r)}%, price ${fmt(r.price)}, move ${pct(r.changePct)}, RSI ${r.rsi.toFixed(0)}. Research trigger ${fmt(l.trigger)}, invalid below ${fmt(l.stop)}, target area ${fmt(l.target)}. Educational only, not financial advice.`;
    fired.push({ symbol: r.symbol, timestamp, aiScore: aiScore(r), confidence: confidence(r), price: r.price, changePct: r.changePct, rsi: r.rsi });
    state.sent[r.symbol] = timestamp;

    if (webhook) {
      for (let i = 1; i <= ALERT_REPEAT_COUNT; i++) {
        await postJson(webhook, { content: `${message} (${i}/${ALERT_REPEAT_COUNT})` });
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
    } else {
      console.log(`Discord webhook not configured; would alert ${r.symbol}`);
    }
  }

  state.updatedAt = timestamp;
  state.lastCandidates = candidates.map(r => ({ symbol: r.symbol, aiScore: aiScore(r), confidence: confidence(r), price: r.price, changePct: r.changePct, rsi: r.rsi }));
  state.lastFired = fired;
  fs.writeFileSync(alertsPath, JSON.stringify(state, null, 2));
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
  const root = path.join(__dirname, '..');
  const out = { updatedAt: timestamp, scannerSize: STOCK_SYMBOLS.length, cryptoSize: CRYPTO_SYMBOLS.length, records };
  fs.writeFileSync(path.join(root, 'prices.json'), JSON.stringify(out, null, 2));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'market.json'), JSON.stringify(out, null, 2));
  const csv = ['symbol,assetType,name,price,changePct,rsi,belowHigh,aboveLow,volume'].concat(records.map(r => [r.symbol, r.assetType, JSON.stringify(r.name || ''), r.price, r.changePct, r.rsi, r.belowHigh, r.aboveLow, r.volume].join(','))).join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'prices.csv'), csv);
  fs.writeFileSync(path.join(root, 'data', 'market.csv'), csv);
  writeHistory(root, timestamp, records);
  await sendDiscordAlerts(root, timestamp, records);
  console.log(`Wrote ${records.length} records, logged history, and checked Discord alerts at ${timestamp}`);
}

main().catch(err => { console.error(err); process.exit(1); });
