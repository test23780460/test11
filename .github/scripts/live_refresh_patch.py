from pathlib import Path

p = Path('index.html')
html = p.read_text()

live_block = r'''function replaceRecord(row){if(!row)return;const i=records.findIndex(r=>r.symbol===row.symbol);if(i>=0)records[i]=row;else records.push(row);bySym.set(row.symbol,row)}
async function refreshLivePrices(){const symbols=uniq([...saved,...cryptoSaved,...MARKET,...CRYPTO]).filter(Boolean).slice(0,48);let changed=0;for(const s of symbols){try{const row=await fetchYahoo(s);if(row){replaceRecord(row);changed++}await new Promise(r=>setTimeout(r,90))}catch(e){}}if(changed){render();$('updated').textContent='Live checked '+new Date().toLocaleTimeString()+' | backend saves every few minutes'}}
'''

if 'function refreshLivePrices()' not in html:
    html = html.replace('function stockInput(s){', live_block + 'function stockInput(s){')

html = html.replace('load();setInterval(load,300000);', 'load();setInterval(load,300000);setInterval(refreshLivePrices,60000);setTimeout(refreshLivePrices,12000);')

if 'function refreshLivePrices()' not in html or 'setInterval(refreshLivePrices,60000)' not in html:
    raise SystemExit('live refresh patch did not apply')

p.write_text(html)
print('live refresh patch applied')
