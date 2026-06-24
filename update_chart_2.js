const fs = require('fs');
let code = fs.readFileSync('index.html', 'utf8');

// 1. Remove top header button
code = code.replace(/<div id="btn-tv-toggle" class="flag-pill"[\s\S]*?<\/div>\n/, '');

// 2. Modify tv-chart-wrapper
const oldTvWrapperRegex = /<div id="tv-chart-wrapper" style="display:none; padding: 0 24px 24px;">\n  <div class="panel" style="height:400px; display:flex; flex-direction:column; overflow:hidden;">\n    <div style="padding:14px 16px; border-bottom:1px solid var\(--border\); display:flex; justify-content:space-between; align-items:center; background:var\(--input-bg\);">\n      \n<div>\n  <div class="sec-label">Testnet Klines<\/div>\n  <div class="sec-title" id="tv-chart-title" style="color:var\(--cyan\);display:flex;align-items:center;gap:8px;">TradingView Chart<\/div>\n<\/div>\n<div style="display:flex;gap:4px;align-items:center;" id="tv-timeframes">\n  <button class="tv-tf-btn on" data-tf="1m">1m<\/button>\n  <button class="tv-tf-btn" data-tf="5m">5m<\/button>\n  <button class="tv-tf-btn" data-tf="15m">15m<\/button>\n  <button class="tv-tf-btn" data-tf="1h">1H<\/button>\n  <button class="tv-tf-btn" data-tf="4h">4H<\/button>\n  <button class="tv-tf-btn" data-tf="1d">1D<\/button>\n<\/div>\n\n      <button onclick="window.toggleTVChart\(\)"[\s\S]*?<\/button>\n    <\/div>\n    <div id="tv-chart" style="flex:1; width:100%;"><\/div>\n  <\/div>\n<\/div>/;

const newTvWrapper = `
<div id="tv-chart-wrapper" style="display:block; padding: 0 24px 24px;">
  <div class="panel" style="display:flex; flex-direction:column; overflow:hidden;">
    <div style="padding:14px 16px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; background:var(--input-bg); cursor:pointer;" onclick="window.toggleTVChart()">
      <div style="display:flex;align-items:center;gap:12px;">
        <div id="tv-chevron" style="color:var(--text-muted);font-size:14px;transition:transform 0.2s;transform:rotate(-90deg);">▼</div>
        <div>
          <div class="sec-label">Testnet Klines</div>
          <div class="sec-title" id="tv-chart-title" style="color:var(--cyan);display:flex;align-items:center;gap:8px;">TradingView Chart</div>
        </div>
      </div>
      <div style="display:flex;gap:4px;align-items:center;" id="tv-timeframes" onclick="event.stopPropagation()">
        <button class="tv-tf-btn on" data-tf="1m">1m</button>
        <button class="tv-tf-btn" data-tf="5m">5m</button>
        <button class="tv-tf-btn" data-tf="15m">15m</button>
        <button class="tv-tf-btn" data-tf="1h">1H</button>
        <button class="tv-tf-btn" data-tf="4h">4H</button>
        <button class="tv-tf-btn" data-tf="1d">1D</button>
      </div>
    </div>
    <div id="tv-chart-container" style="display:none; height:400px; flex-direction:column; width:100%; border-top:1px solid var(--border);">
      <div id="tv-chart" style="flex:1; width:100%;"></div>
    </div>
  </div>
</div>
`;

code = code.replace(oldTvWrapperRegex, newTvWrapper.trim());

// 3. Update window.toggleTVChart definition in script
const oldToggle = /window\.toggleTVChart = \(\) => \{[\s\S]*? btn\.style\.boxShadow = '0 0 10px rgba\(6,182,212,0\.1\)';\n            \}\n        \};/;

const newToggle = `
        window.toggleTVChart = () => {
            window.tvIsVisible = !window.tvIsVisible;
            const container = document.getElementById('tv-chart-container');
            const chevron = document.getElementById('tv-chevron');
            if (window.tvIsVisible) {
                container.style.display = 'flex';
                chevron.style.transform = 'rotate(0deg)';
                if (!window.tvChart) {
                    window.initTVChart(activeTabSymbol);
                }
            } else {
                container.style.display = 'none';
                chevron.style.transform = 'rotate(-90deg)';
            }
        };
`;

code = code.replace(oldToggle, newToggle.trim());

// 4. Update initTVChart to add rightOffset
const oldTimeScale = /timeScale: \{ borderColor: grid, timeVisible: true \},/;
const newTimeScale = `timeScale: { borderColor: grid, timeVisible: true, rightOffset: 12 },`;

code = code.replace(oldTimeScale, newTimeScale);

fs.writeFileSync('index.html', code);
console.log('Update successful');
