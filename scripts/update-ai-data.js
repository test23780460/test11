const fs = require('fs');
const https = require('https');
const path = require('path');

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');
const outFile = path.join(dataDir, 'ai.json');
const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const key = process.env.OPENAI_API_KEY;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeJson(data) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(data, null, 2));
}

function pct(n) {
  return Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : 'n/a';
}

function rankRecord(r, historical, news) {
  const h = historical.records && historical.records[r.symbol] || {};
  const headlines = (news.headlines || []).filter(n => n.symbol === r.symbol).slice(0, 3);
  const momentum = Number(r.changePct) || 0;
  const dip = Math.max(0, -momentum);
  const volPenalty = Number(h.annualizedVolatility) ? Math.min(18, h.annualizedVolatility / 4) : 8;
  const trendBoost = h.trend === 'uptrend' ? 18 : h.trend === 'recovering' ? 10 : h.trend === 'downtrend' ? -16 : 0;
  const newsBoost = headlines.reduce((sum, n) => sum + ((n.sentiment && n.sentiment.score) || 50) - 50, 0) / 8;
  return 50 + dip * 4 + momentum * 1.5 + trendBoost + newsBoost - volPenalty;
}

function buildPayload() {
  const prices = readJson(path.join(root, 'prices.json'), { records: [] });
  const history = readJson(path.join(dataDir, 'history.json'), { runs: [] });
  const historical = readJson(path.join(dataDir, 'historical.json'), { records: {} });
  const news = readJson(path.join(dataDir, 'news.json'), { headlines: [] });
  const records = prices.records || [];
  const ranked = [...records]
    .filter(r => r.assetType === 'stock')
    .sort((a, b) => rankRecord(b, historical, news) - rankRecord(a, historical, news))
    .slice(0, 18)
    .map(r => {
      const h = historical.records && historical.records[r.symbol] || {};
      const headlines = (news.headlines || []).filter(n => n.symbol === r.symbol).slice(0, 3);
      return {
        symbol: r.symbol,
        name: r.name,
        price: r.price,
        todayMove: pct(r.changePct),
        rsi: Math.round(r.rsi || 0),
        trend: h.trend || 'unknown',
        oneMonth: Number.isFinite(h.change1m) ? pct(h.change1m) : 'n/a',
        threeMonth: Number.isFinite(h.change3m) ? pct(h.change3m) : 'n/a',
        volatility: Number.isFinite(h.annualizedVolatility) ? Math.round(h.annualizedVolatility) + '%' : 'n/a',
        drawdown: Number.isFinite(h.maxDrawdown) ? h.maxDrawdown + '%' : 'n/a',
        dipRecoveryRate: h.dipRecoveryRate == null ? 'n/a' : h.dipRecoveryRate + '%',
        headlines: headlines.map(n => ({ title: n.title, tone: n.sentiment && n.sentiment.label, score: n.sentiment && n.sentiment.score }))
      };
    });

  return {
    generatedAt: new Date().toISOString(),
    marketUpdatedAt: prices.updatedAt || null,
    latestRun: history.runs && history.runs[0] || null,
    market: {
      totalRecords: records.length,
      stockAverageMove: history.runs && history.runs[0] ? pct(history.runs[0].stockAverageMove) : 'n/a',
      cryptoAverageMove: history.runs && history.runs[0] ? pct(history.runs[0].cryptoAverageMove) : 'n/a',
      advancers: history.runs && history.runs[0] ? history.runs[0].advancers : null,
      decliners: history.runs && history.runs[0] ? history.runs[0].decliners : null,
      newsMood: news.marketRead || 'No news read yet'
    },
    candidates: ranked
  };
}

function requestJson(body) {
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`OpenAI ${res.statusCode}: ${data.slice(0, 500)}`));
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
    });
    req.setTimeout(45000, () => req.destroy(new Error('OpenAI timeout')));
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function outputText(resp) {
  if (resp.output_text) return resp.output_text;
  const chunks = [];
  for (const item of resp.output || []) {
    for (const c of item.content || []) {
      if (c.text) chunks.push(c.text);
    }
  }
  return chunks.join('\n').trim();
}

function parseAiJson(text) {
  try { return JSON.parse(text); } catch (_) {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error('AI response was not JSON');
}

async function main() {
  const payload = buildPayload();
  if (!key) {
    writeJson({
      configured: false,
      realAi: false,
      updatedAt: new Date().toISOString(),
      model,
      headline: 'Real AI is ready, but OPENAI_API_KEY is not set yet.',
      marketRead: 'Add OPENAI_API_KEY as a GitHub Actions secret, then run the AI workflow.',
      watchPlans: [],
      warnings: ['Do not put API keys in public website code. Use GitHub Secrets only.'],
      source: { marketUpdatedAt: payload.marketUpdatedAt, candidates: payload.candidates.length }
    });
    return;
  }

  const system = 'You are a cautious market research assistant for a stock dashboard. Use only the provided data. Do not claim certainty, do not give personalized financial advice, and do not tell the user to buy now. Produce concise research, watch plans, risks, and triggers. Return JSON only.';
  const user = `Analyze this dashboard data and return JSON with this shape: {"configured":true,"realAi":true,"headline":"short market headline","marketRead":"2-4 sentence overview","watchPlans":[{"symbol":"AAPL","stance":"research|watch|wait|avoid","confidence":0-100,"why":"short reason","watchFor":"entry/confirmation idea","risk":"main risk","timeframe":"short timeframe"}],"warnings":["short caution"]}. Data: ${JSON.stringify(payload)}`;

  const resp = await requestJson({
    model,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: system }] },
      { role: 'user', content: [{ type: 'input_text', text: user }] }
    ],
    temperature: 0.2,
    max_output_tokens: 2200
  });

  const ai = parseAiJson(outputText(resp));
  writeJson({
    ...ai,
    configured: true,
    realAi: true,
    updatedAt: new Date().toISOString(),
    model,
    source: { marketUpdatedAt: payload.marketUpdatedAt, candidates: payload.candidates.length }
  });
}

main().catch(err => {
  writeJson({
    configured: Boolean(key),
    realAi: false,
    updatedAt: new Date().toISOString(),
    model,
    headline: 'AI update failed',
    marketRead: err.message,
    watchPlans: [],
    warnings: ['The scanner still works, but the real AI brief could not be generated. Check OpenAI billing/quota or replace the GitHub secret.'],
    source: {}
  });
  console.error(err.message);
});
