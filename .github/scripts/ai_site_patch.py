from pathlib import Path

p = Path('index.html')
html = p.read_text()

html = html.replace("<button class=\"btn tab\" onclick=\"showPage('news',this)\">News</button><button class=\"btn tab\" onclick=\"showPage('predict',this)\">Predictions</button>", "<button class=\"btn tab\" onclick=\"showPage('news',this)\">News</button><button class=\"btn tab\" onclick=\"showPage('ai',this)\">Real AI</button><button class=\"btn tab\" onclick=\"showPage('predict',this)\">Predictions</button>")

html = html.replace('history=null,historical=null,alerts=null,news=null,scannerSize=0', 'history=null,historical=null,alerts=null,news=null,ai=null,scannerSize=0')

ai_section = '''\n<section id=\"aiPage\" class=\"grid page\"><section class=\"panel span12\"><div class=\"section\"><h3>Real AI Market Brief</h3><span class=\"muted\" id=\"aiUpdated\">Waiting for AI backend</span></div><div id=\"aiKpis\" class=\"kpis\"></div></section><section class=\"panel span8\"><div class=\"section\"><h3>AI Read</h3><span class=\"muted\">Generated from saved market, news, and historical data</span></div><div id=\"aiBrief\" class=\"detailPanel\"></div></section><aside class=\"panel span4\"><div class=\"section\"><h3>AI Warnings</h3><span class=\"muted\">Risk notes</span></div><div id=\"aiWarnings\" class=\"list\"></div></aside><section class=\"panel span12\"><div class=\"section\"><h3>AI Watch Plans</h3><span class=\"muted\">Research ideas, not financial advice</span></div><div id=\"aiPlans\" class=\"cards\"></div></section></section>\n'''
if 'id=\"aiPage\"' not in html:
    html = html.replace('<section id=\"ideasPage\"', ai_section + '<section id=\"ideasPage\"')

if "data/ai.json" not in html:
    html = html.replace("try{const n=await fetch('data/news.json?x='+Date.now());if(n.ok)news=await n.json()}catch(e){}render();", "try{const n=await fetch('data/news.json?x='+Date.now());if(n.ok)news=await n.json()}catch(e){}try{const ar=await fetch('data/ai.json?x='+Date.now());if(ar.ok)ai=await ar.json()}catch(e){}render();")

ai_functions = r'''function renderAI(){if(!$('aiKpis'))return;const on=!!ai?.realAi,plans=ai?.watchPlans||[],updated=ai?.updatedAt?new Date(ai.updatedAt).toLocaleString():'Waiting';$('aiUpdated').textContent=updated;$('aiKpis').innerHTML=[metric('Real AI',on?'On':'Needs key',on?'up':'gold'),metric('Model',ai?.model||'not set','violet'),metric('Plans',plans.length,'cyan'),metric('Market data',ai?.source?.marketUpdatedAt?new Date(ai.source.marketUpdatedAt).toLocaleTimeString():'waiting','blue'),metric('Status',ai?.configured?'Configured':'No secret',ai?.configured?'up':'down')].join('');$('aiBrief').innerHTML=`<h3>${esc(ai?.headline||'AI brief waiting')}</h3><p class="muted">${esc(ai?.marketRead||'The real AI backend is ready, but it needs the private OPENAI_API_KEY GitHub secret before it can generate model output.')}</p><p class="note">The public website never stores or sees the API key. AI output is research support only.</p>`;$('aiWarnings').innerHTML=(ai?.warnings||['Waiting for AI backend.']).map(w=>`<div class="rowItem"><span>${esc(w)}</span></div>`).join('');$('aiPlans').innerHTML=plans.length?plans.slice(0,12).map(p=>`<div class="asset ideaCard" onclick="${p.symbol?`openAsset('${esc(p.symbol)}')`:''}"><div class="ideaHeader"><div><b class="sym">${esc(p.symbol||'AI')}</b><div class="muted">${esc(p.stance||'research')} | confidence ${esc(p.confidence??'--')}</div></div><span class="tag ${String(p.stance||'').includes('avoid')?'peak':String(p.stance||'').includes('wait')?'neutral':'dip'}">Real AI</span></div><p class="muted"><b>Why:</b> ${esc(p.why||'No reason provided.')}</p><p class="muted"><b>Watch for:</b> ${esc(p.watchFor||'No trigger provided.')}</p><p class="muted"><b>Risk:</b> ${esc(p.risk||'Risk not provided.')}</p><p class="muted"><b>Timeframe:</b> ${esc(p.timeframe||'Not specified')}</p></div>`).join(''):'<div class="asset muted">Real AI plans will appear here after OPENAI_API_KEY is added as a private GitHub Actions secret and the AI workflow runs.</div>'}
'''
if 'function renderAI(){' not in html:
    html = html.replace('function renderIdeas(all){', ai_functions + 'function renderIdeas(all){')

html = html.replace('renderIdeas(all);renderNews();renderPredictions(all);renderBackend()', 'renderIdeas(all);renderNews();renderAI();renderPredictions(all);renderBackend()')

# Collapse duplicate live refresh timers from earlier patching.
dup = 'setInterval(refreshLivePrices,60000);setTimeout(refreshLivePrices,12000);setInterval(refreshLivePrices,60000);setTimeout(refreshLivePrices,12000);'
html = html.replace(dup, 'setInterval(refreshLivePrices,60000);setTimeout(refreshLivePrices,12000);')

required = ['showPage(\'ai\'', 'id=\"aiPage\"', 'data/ai.json', 'function renderAI(){']
missing = [x for x in required if x not in html]
if missing:
    raise SystemExit('AI site patch missing: ' + ', '.join(missing))

p.write_text(html)
print('AI site patch applied')
