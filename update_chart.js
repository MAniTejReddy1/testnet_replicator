const fs = require('fs');
let code = fs.readFileSync('index.html', 'utf8');

// 1. Move tv-chart-wrapper above the orderbook grid
const tvWrapRegex = /<div id="tv-chart-wrapper"[\s\S]*?<\/div>\n<\/div>\n/;
const tvWrapMatch = code.match(tvWrapRegex);
if (tvWrapMatch) {
    code = code.replace(tvWrapMatch[0], '');
    const gridRegex = /<div style="display:grid;grid-template-columns:1fr 1fr 380px;gap:16px;padding:24px;">/;
    code = code.replace(gridRegex, tvWrapMatch[0] + '\n' + '<div style="display:grid;grid-template-columns:1fr 1fr 380px;gap:16px;padding:24px;">');
}

// 2. Update tv-chart-wrapper HTML to add timeframe buttons and dynamic title
const oldHeader = /<div><div class="sec-label">Testnet Klines<\/div><div class="sec-title" style="color:var\(--cyan\);display:flex;align-items:center;gap:8px;">TradingView Chart<\/div><\/div>/;
const newHeader = `
<div>
  <div class="sec-label">Testnet Klines</div>
  <div class="sec-title" id="tv-chart-title" style="color:var(--cyan);display:flex;align-items:center;gap:8px;">TradingView Chart</div>
</div>
<div style="display:flex;gap:4px;align-items:center;" id="tv-timeframes">
  <button class="tv-tf-btn on" data-tf="1m">1m</button>
  <button class="tv-tf-btn" data-tf="5m">5m</button>
  <button class="tv-tf-btn" data-tf="15m">15m</button>
  <button class="tv-tf-btn" data-tf="1h">1H</button>
  <button class="tv-tf-btn" data-tf="4h">4H</button>
  <button class="tv-tf-btn" data-tf="1d">1D</button>
</div>
`;
code = code.replace(oldHeader, newHeader);

// Add CSS for timeframe buttons
const styleInsert = `
.tv-tf-btn { background: transparent; border: 1px solid var(--border); color: var(--text-muted); border-radius: 4px; padding: 4px 8px; font-size: 10px; cursor: pointer; font-family: 'Inter', sans-serif; transition: all 0.2s; font-weight: 700; }
.tv-tf-btn:hover { color: var(--text-main); background: var(--hover-bg); }
.tv-tf-btn.on { background: rgba(6,182,212,0.1); color: var(--cyan); border-color: rgba(6,182,212,0.3); }
`;
code = code.replace('</style>', styleInsert + '</style>');

// 3. Update window.initTVChart logic
let jsChanges = `
        window.tvInterval = '1m';
        window.initTVChart = async (pair, interval = window.tvInterval) => {
            window.tvInterval = interval;
            const container = document.getElementById('tv-chart');
            if (window.tvChart) {
                window.tvChart.remove();
                window.tvChart = null;
            }
            if (window.tvWs) {
                window.tvWs.close();
                window.tvWs = null;
            }

            // Update header
            const titleEl = document.getElementById('tv-chart-title');
            if (titleEl) titleEl.innerHTML = pair + ' <span style="color:var(--text-muted)">•</span> ' + interval.toUpperCase() + ' <span style="color:var(--text-muted)">•</span> <span style="font-size:9px;color:var(--cyan);background:rgba(6,182,212,0.1);padding:2px 6px;border-radius:4px;border:1px solid rgba(6,182,212,0.2);">IST</span>';

            // Update buttons
            document.querySelectorAll('.tv-tf-btn').forEach(b => {
                if (b.getAttribute('data-tf') === interval) b.classList.add('on');
                else b.classList.remove('on');
                b.onclick = () => window.initTVChart(activeTabSymbol, b.getAttribute('data-tf'));
            });

            const isLight = document.documentElement.getAttribute('data-theme') === 'light';
            const text = isLight ? '#64748b' : '#94a3b8';
            const grid = isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.04)';

            window.tvChart = LightweightCharts.createChart(container, {
                width: container.clientWidth,
                height: container.clientHeight,
                layout: { background: { type: 'solid', color: 'transparent' }, textColor: text },
                grid: { vertLines: { color: grid }, horzLines: { color: grid } },
                crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
                rightPriceScale: { borderColor: grid },
                timeScale: { borderColor: grid, timeVisible: true },
                watermark: { visible: true, text: pair, color: isLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.03)', fontSize: 120, horzAlign: 'center', vertAlign: 'center' }
            });

            window.tvSeries = window.tvChart.addCandlestickSeries({
                upColor: '#10b981', downColor: '#f43f5e', borderVisible: false,
                wickUpColor: '#10b981', wickDownColor: '#f43f5e'
            });

            const IST_OFFSET = 19800; // +5:30 in seconds

            try {
                const res = await fetch(\`https://testnet-futures-mds-read.dcxstage.com/fapi/v1/klines?symbol=\${pair}&interval=\${interval}&limit=500\`);
                const data = await res.json();
                const formatted = data.map(d => ({
                    time: (d[0] / 1000) + IST_OFFSET,
                    open: parseFloat(d[1]), high: parseFloat(d[2]), low: parseFloat(d[3]), close: parseFloat(d[4])
                }));
                window.tvSeries.setData(formatted);
            } catch(e) {
                console.error('Failed to fetch historical klines', e);
            }

            window.tvWs = new WebSocket(\`wss://testnet-futures-socket-gateway.dcxstage.com/market/ws/\${pair.toLowerCase()}@kline_\${interval}\`);
            window.tvWs.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.e === 'kline') {
                    const k = msg.k;
                    window.tvSeries.update({
                        time: (k.t / 1000) + IST_OFFSET,
                        open: parseFloat(k.o), high: parseFloat(k.h), low: parseFloat(k.l), close: parseFloat(k.c)
                    });
                }
            };
            
            const resizeObserver = new ResizeObserver(entries => {
                if (entries.length === 0 || entries[0].target !== container) return;
                const newRect = entries[0].contentRect;
                window.tvChart.applyOptions({ width: newRect.width, height: newRect.height });
            });
            resizeObserver.observe(container);
        };
`;

const oldFuncRegex = /window\.initTVChart = async \(pair\) => \{[\s\S]*?resizeObserver\.observe\(container\);\n        \};/;
code = code.replace(oldFuncRegex, jsChanges.trim());

fs.writeFileSync('index.html', code);
console.log('Modifications applied successfully.');
