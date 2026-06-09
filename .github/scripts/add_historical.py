from pathlib import Path
import re

root = Path('.')

stock_js = root / 'scripts' / 'update-stock-data.js'
text = stock_js.read_text()
if 'HISTORICAL_REFRESH_HOURS' not in text:
    text = text.replace("const NEWS_PER_SYMBOL = 4;", "const NEWS_PER_SYMBOL = 4;\nconst HISTORICAL_REFRESH_HOURS = 12;\nconst HISTORICAL_RANGE = '1y';\nconst HISTORICAL_INTERVAL = '1d';")

historical_helpers = r'''
function mean(values) {
  const nums = values.filter(Number.isFinite);
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function stdev(values) {
  const m = mean(values);
  if (!Number.isFinite(m)) return null;
  const nums = values.filter(Number.isFinite);
  return nums.length ? Math.sqrt(nums.reduce((sum, v) => sum + Math.pow(v - m, 2), 0) / nums.length) : null;
}

function lastMean(values, count) {
  return mean(values.slice(-count));
}

function pctChange(values, sessions) {
  if (values.length <= sessions) return null;
  const now = values[values.length - 1];
  const then = values[values.length - 1 - sessions];
  return Number.isFinite(now) && Number.isFinite(then) && then !== 0 ? ((now - then) / then) * 100 : null;
}

function maxDrawdown(closes) {
  let peak = closes[0] || 0;
  let worst = 0;
  for (const close of closes) {
    if (close > peak) peak = close;
    if (peak) worst = Math.min(worst, ((close - peak) / peak) * 100);
  }
  return Math.round(Math.abs(worst) * 10) / 10;
}

function dipRecoveryRate(closes) {
  let dips = 0;
  let recovered = 0;
  for (let i = 1; i < closes.length - 5; i++) {
    const prior = closes[i - 1];
    const cur = closes[i];
    if (!prior || ((cur - prior) / prior) * 100 > -3) continue;
    dips++;
    const next = closes.slice(i + 1, i + 6);
    if (next.some(v => v >= prior)) recovered++;
  }
  return dips ? Math.round((recovered / dips) * 100) : null;
}

function windowWinRate(closes, sessions) {
  let total = 0;
  let wins = 0;
  for (let i = 0; i + sessions < closes.length; i++) {
    total++;
    if (closes[i + sessions] > closes[i]) wins++;
  }
  return total ? Math.round((wins / total) * 100) : null;
}

function historicalTrend(price, sma50, sma200) {
  if (![price, sma50, sma200].every(Number.isFinite)) return 'waiting';
  if (price > sma50 && sma50 > sma200) return 'uptrend';
  if (price < sma50 && sma50 < sma200) return 'downtrend';
  if (price > sma50 && sma50 <= sma200) return 'recovering';
  return 'mixed';
}

function normalizeHistorical(raw, current) {
  const q = raw.chart && raw.chart.result && raw.chart.result[0];
  if (!q) return null;
  const quote = (q.indicators && q.indicators.quote && q.indicators.quote[0]) || {};
  const times = q.timestamp || [];
  const rows = (quote.close || []).map((close, i) => ({ close, time: times[i] })).filter(p => Number.isFinite(p.close));
  const closes = rows.map(p => p.close);
  if (closes.length < 20) return null;
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1]) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const price = current.price || closes[closes.length - 1];
  const high52 = Math.max(...closes);
  const low52 = Math.min(...closes);
  const sma20 = lastMean(closes, 20);
  const sma50 = lastMean(closes, 50);
  const sma200 = lastMean(closes, 200);
  const vol = stdev(returns);
  const avgMove = mean(returns.map(v => Math.abs(v)));
  return {
    symbol: current.symbol,
    assetType: current.assetType,
    updatedAt: new Date().toISOString(),
    days: closes.length,
    price,
    high52,
    low52,
    below52High: high52 ? ((high52 - price) / high52) * 100 : null,
    above52Low: low52 ? ((price - low52) / low52) * 100 : null,
    sma20,
    sma50,
    sma200,
    trend: historicalTrend(price, sma50, sma200),
    change1m: pctChange(closes, 21),
    change3m: pctChange(closes, 63),
    change6m: pctChange(closes, 126),
    change1y: pctChange(closes, 252),
    annualizedVolatility: Number.isFinite(vol) ? vol * Math.sqrt(252) * 100 : null,
    avgDailyMove: Number.isFinite(avgMove) ? avgMove * 100 : null,
    maxDrawdown: maxDrawdown(closes),
    dipRecoveryRate: dipRecoveryRate(closes),
    winRate20: windowWinRate(closes, 20),
    lastClose: closes[closes.length - 1],
    lastDate: rows[rows.length - 1].time ? new Date(rows[rows.length - 1].time * 1000).toISOString().slice(0, 10) : null
  };
}

async function fetchHistoricalForSymbol(symbol, current) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${HISTORICAL_RANGE}&interval=${HISTORICAL_INTERVAL}`;
  return normalizeHistorical(await getJson(url), current);
}

async function buildHistorical(root, timestamp, records) {
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'historical.json');
  const old = readJson(file, { records: {}, updatedAt: null });
  const lastMs = old.updatedAt ? new Date(old.updatedAt).getTime() : 0;
  if (lastMs && Date.now() - lastMs < HISTORICAL_REFRESH_HOURS * 60 * 60 * 1000 && old.records && Object.keys(old.records).length) {
    const merged = { ...old.records };
    for (const r of records) if (merged[r.symbol]) merged[r.symbol].price = r.price;
    fs.writeFileSync(file, JSON.stringify({ ...old, updatedAt: timestamp, records: merged }, null, 2));
    return;
  }

  const out = { ...(old.records || {}) };
  for (const record of records) {
    try {
      const row = await fetchHistoricalForSymbol(record.symbol, record);
      if (row) out[record.symbol] = row;
      await new Promise(resolve => setTimeout(resolve, 180));
    } catch (err) {
      console.warn(`Skipping historical ${record.symbol}: ${err.message}`);
    }
  }
  fs.writeFileSync(file, JSON.stringify({ updatedAt: timestamp, range: HISTORICAL_RANGE, interval: HISTORICAL_INTERVAL, count: Object.keys(out).length, records: out }, null, 2));
}
'''

if 'function buildHistorical(' not in text:
    text = text.replace('function writeHistory(root, timestamp, records) {', historical_helpers + '\nfunction writeHistory(root, timestamp, records) {')
if 'await buildHistorical(root, timestamp, records);' not in text:
    text = text.replace('  writeHistory(root, timestamp, records);\n  await buildNews(root, timestamp, records);', '  writeHistory(root, timestamp, records);\n  await buildHistorical(root, timestamp, records);\n  await buildNews(root, timestamp, records);')
text = text.replace('Wrote ${records.length} records, logged history, and checked Discord alerts at ${timestamp}', 'Wrote ${records.length} records, logged history, refreshed historical data, and checked Discord alerts at ${timestamp}')
stock_js.write_text(text)

workflow = root / '.github' / 'workflows' / 'update-stock-data.yml'
w = workflow.read_text()
if 'data/historical.json' not in w:
    w = w.replace('file_pattern: prices.json prices.csv data/market.json data/market.csv data/history.json data/history.csv data/alerts.json data/news.json', 'file_pattern: prices.json prices.csv data/market.json data/market.csv data/history.json data/history.csv data/alerts.json data/news.json data/historical.json')
workflow.write_text(w)

index = root / 'index.html'
html = index.read_text()
html = html.replace('history=null,alerts=null,news=null', 'history=null,historical=null,alerts=null,news=null')
if "data/historical.json" not in html:
    html = html.replace("try{const h=await fetch('data/history.json?x='+Date.now());if(h.ok)history=await h.json()}catch(e){}try{const a=await fetch('data/alerts.json?x='+Date.now());", "try{const h=await fetch('data/history.json?x='+Date.now());if(h.ok)history=await h.json()}catch(e){}try{const h2=await fetch('data/historical.json?x='+Date.now());if(h2.ok)historical=await h2.json()}catch(e){}try{const a=await fetch('data/alerts.json?x='+Date.now());")

hist_block = r'''function histFor(r){return historical?.records?.[r.symbol]||null}function histQuality(h){return h?.days>=200?'1 year':h?.days>=120?'6 months':h?.days>=50?'recent history':'intraday only'}function histSafetyBoost(h){if(!h)return 0;let n=0;if(h.trend==='uptrend')n+=10;if(h.trend==='recovering')n+=5;if(h.trend==='downtrend')n-=12;if(h.annualizedVolatility>55)n-=10;else if(h.annualizedVolatility>35)n-=5;else if(h.annualizedVolatility<24)n+=5;if(h.dipRecoveryRate>=65)n+=8;else if(h.dipRecoveryRate!==null&&h.dipRecoveryRate<35)n-=8;if(h.winRate20>=58)n+=5;else if(h.winRate20!==null&&h.winRate20<45)n-=5;return n}function histRangeBoost(h){if(!h)return 1;const vol=Number(h.annualizedVolatility)||30;return clamp(vol/30,.65,2.4)}function safetyFor(r){const ni=newsImpactFor(r),h=histFor(r),raw=42+confidence(r)*.20+totalScore(r)*.23+ni.score*.10-riskScore(r)*.25+(signal(r).key==='peak'?-8:signal(r).key==='dip'?4:0)+histSafetyBoost(h);return clamp(Math.round(raw),1,99)}function predictionFor(r,amount,horizon){const p=levels(r),h=histFor(r),mult=horizonMult(horizon),histMult=histRangeBoost(h),ni=newsImpactFor(r),safe=safetyFor(r),shares=amount/(r.price||1),histTarget=h?.high52&&h.high52>r.price?h.high52:r.price+p.vol*1.15,histStop=h?.sma50&&h.sma50<r.price?h.sma50:r.price-p.vol*.85,baseTarget=Math.max(p.target,Math.min(histTarget,r.price*(1+.18*mult*histMult))),baseStop=Math.min(p.stop,histStop),upPct=clamp((baseTarget-r.price)/r.price*100*mult,.4,55),downPct=clamp((r.price-baseStop)/r.price*100*mult*histMult,.4,55),trendEdge=h?.trend==='uptrend'?0.7:h?.trend==='recovering'?0.35:h?.trend==='downtrend'?-0.9:0,recoveryEdge=Number.isFinite(h?.dipRecoveryRate)?(h.dipRecoveryRate-50)*.018:0,expectedPct=clamp((totalScore(r)-50)*.05+(ni.score-50)*.022+(confidence(r)-60)*.022-(riskScore(r)-50)*.032+trendEdge+recoveryEdge,-downPct,upPct),gain=amount*upPct/100,loss=amount*downPct/100,expected=amount*expectedPct/100;return{r,amount,horizon,shares,safe,upPct,downPct,expectedPct,gain,loss,expected,target:r.price*(1+upPct/100),stop:r.price*(1-downPct/100),label:safe>=75?'Safer':safe>=55?'Moderate':safe>=38?'Risky':'Very risky',ni,h}}function predictionRead(p){const s=signal(p.r),h=p.h;if(h&&h.trend==='downtrend')return`Older data says this is in a downtrend, so the prediction is more cautious even if the short-term chart improves.`;if(h&&h.dipRecoveryRate!==null&&h.dipRecoveryRate>=65&&s.key==='dip')return`Older data says this stock has recovered from many previous dips, which improves the safety estimate, but the current trigger still matters.`;if(p.safe>=75&&p.expected>0)return`This looks like one of the safer research setups right now. The estimate is positive, and older trend data is helping confirm it.`;if(p.expected>0)return`The setup has possible upside, but safety is only ${p.label.toLowerCase()}. Wait for confirmation near the trigger before trusting it.`;if(s.key==='peak')return`The scanner sees peak risk. It may still move, but the safety score says chasing it here is dangerous.`;return`The math does not show a clean edge yet. It may be better to wait for a stronger setup or smaller test amount.`}function predictionHtml(p){const r=p.r,plan=setupPlan(r),h=p.h;return`<div class="line"><div><h3>${clean(r.symbol)} Prediction</h3><div class="muted">${esc(r.name||'')} | ${horizonName(p.horizon)} estimate | ${fmt(r.price)} | history: ${histQuality(h)}</div></div><span class="tag ${p.safe>=75?'dip':p.safe<45?'peak':'neutral'}">${p.label}</span></div><div class="moneyBig ${p.expected>=0?'up':'down'}">${money(p.expected)}</div><p class="muted">Estimated expected result on ${money(p.amount)}: <b class="${p.expected>=0?'up':'down'}">${pct(p.expectedPct)}</b>. You would get about <b>${p.shares.toFixed(p.shares>=10?2:4)}</b> shares at the current price.</p><div class="rangeGrid"><div class="rangeBox"><small class="muted">Possible upside</small><b class="up">${money(p.gain)}</b><div class="muted">${pct(p.upPct)} near ${fmt(p.target)}</div></div><div class="rangeBox"><small class="muted">Possible loss</small><b class="down">${money(-p.loss)}</b><div class="muted">-${p.downPct.toFixed(2)}% near ${fmt(p.stop)}</div></div><div class="rangeBox"><small class="muted">News impact</small><b>${p.ni.score}</b><div class="muted">${p.ni.label}</div></div></div><div class="rangeGrid" style="margin-top:8px"><div class="rangeBox"><small class="muted">Long trend</small><b>${esc(h?.trend||'waiting')}</b><div class="muted">20/50/200 day averages</div></div><div class="rangeBox"><small class="muted">Volatility</small><b>${h?.annualizedVolatility?Math.round(h.annualizedVolatility)+'%':'--'}</b><div class="muted">1-year annualized</div></div><div class="rangeBox"><small class="muted">Dip recovery</small><b>${h?.dipRecoveryRate!==null&&h?.dipRecoveryRate!==undefined?h.dipRecoveryRate+'%':'--'}</b><div class="muted">Past 1-year dips</div></div></div><div class="detailGrid"><div class="detailPanel"><h3>What It Means</h3><p class="muted">${predictionRead(p)}</p></div><div class="detailPanel"><h3>Plan</h3><p class="muted">${plan.entry}</p><p class="muted">${plan.exit}</p></div></div>`}function renderPredictions(all){if(!$('predictionIdeas'))return;const amount=parseMoney($('predictAmount')?.value)||100,horizon=$('predictHorizon')?.value||'1w';const ranked=all.filter(r=>!isCrypto(r.symbol)).map(r=>predictionFor(r,amount,horizon)).sort((a,b)=>(b.safe+b.expectedPct*2)-(a.safe+a.expectedPct*2));$('predictionIdeas').innerHTML=ranked.slice(0,8).map(p=>`<div class="asset ideaCard" onclick="quickPredict('${p.r.symbol}',${amount})"><div class="ideaHeader"><div><b class="sym">${clean(p.r.symbol)}</b><div class="muted">${esc(p.r.name||'')} | ${fmt(p.r.price)}</div></div><div class="scoreBadge" style="--score:${p.safe}">${p.safe}</div></div><div class="pillRow"><span class="tag ${p.safe>=75?'dip':p.safe<45?'peak':'neutral'}">${p.label}</span><span class="tag gold">Could ${money(p.gain)}</span><span class="tag neutral">Risk ${money(p.loss)}</span></div><div class="bar"><i style="width:${clamp(50+p.expectedPct*3,1,99)}%"></i></div><p class="muted"><b>Estimate:</b> ${money(p.expected)} expected on ${money(amount)} over ${horizonName(horizon)}.</p><p class="muted"><b>History:</b> ${histQuality(p.h)} | ${esc(p.h?.trend||'waiting for backend')}</p></div>`).join('')}'''
if 'function histFor(r)' not in html:
    html = html.replace('function renderBackend(){', hist_block + '\nfunction renderBackend(){')

backend_new = "function renderBackend(){const run=history?.runs?.[0],fired=alerts?.lastFired?.length||0,candidates=alerts?.lastCandidates?.length||0,hCount=historical?.records?Object.keys(historical.records).length:0;$('backendKpis').innerHTML=[metric('History runs',history?.runs?.length||0,'cyan'),metric('Latest log',run?new Date(run.timestamp).toLocaleString():'Waiting','gold'),metric('Logged records',run?.totalRecords||0,'violet'),metric('Historical symbols',hCount,'blue'),metric('Alerts sent last run',fired,'down')].join('');$('backendRuns').innerHTML=(history?.runs||[]).slice(0,8).map(r=>`<div class=\"log\"><div class=\"line\"><b>${new Date(r.timestamp).toLocaleString()}</b><span>${r.totalRecords} rows</span></div><div class=\"muted\">Stocks ${r.stockRecords} | Crypto ${r.cryptoRecords} | Avg stocks ${pct(r.stockAverageMove)} | Avg crypto ${pct(r.cryptoAverageMove)}</div></div>`).join('')||'<div class=\"log muted\">No backend log yet.</div>'}"
html = re.sub(r"function renderBackend\(\)\{.*?\}\nfunction timeLabel", backend_new + "\nfunction timeLabel", html, flags=re.S)

required = ['data/historical.json', 'function histFor(r)', 'Historical symbols']
missing = [item for item in required if item not in html]
if missing:
    raise SystemExit('index patch missing: ' + ', '.join(missing))
index.write_text(html)

print('historical patch applied')
