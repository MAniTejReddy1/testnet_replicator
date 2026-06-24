const fs = require('fs');

// --- 1. PATCH REPLICATOR.JS ---
let repCode = fs.readFileSync('replicator.js', 'utf8');

// Add properties to Replicator constructor
const constrRegex = /this\.binanceLatency = 0;/;
repCode = repCode.replace(constrRegex, "this.binanceLatency = 0;\n        this.testnetLtp = null;\n        this.testnetKline = null;\n        this.currentKlineInterval = '1m';");

// Add startTestnetTickerWS and startTestnetKlineWS
const startRegex = /startTestnetWS\(\) \{/;
const newMethods = `
    startTestnetTickerWS() {
        if (this.wsTestnetTicker) return;
        const sym = this.symbol.toLowerCase();
        const streamUrl = \`wss://testnet-futures-socket-gateway.dcxstage.com/market/ws/\${sym}@ticker\`;
        log.info(this.symbol, \`[WS] Connecting to 24h Ticker...\`);
        this.wsTestnetTicker = new WebSocket(streamUrl);
        this.wsTestnetTicker.on('message', (raw) => {
            if (this.status === 'STOPPED') return;
            try {
                const data = JSON.parse(raw.toString());
                if (data.e === '24hrTicker') {
                    this.testnetLtp = parseFloat(data.c);
                    broadcastToUI();
                }
            } catch(e) {}
        });
        this.wsTestnetTicker.on('close', () => { this.wsTestnetTicker = null; if (this.status !== 'STOPPED') setTimeout(() => this.startTestnetTickerWS(), 3000); });
        this.wsTestnetTicker.on('error', () => {});
    }

    startTestnetKlineWS(interval) {
        if (this.wsTestnetKline) {
            this.wsTestnetKline.close();
            this.wsTestnetKline = null;
        }
        this.currentKlineInterval = interval || this.currentKlineInterval || '1m';
        const sym = this.symbol.toLowerCase();
        const streamUrl = \`wss://testnet-futures-socket-gateway.dcxstage.com/market/ws/\${sym}@kline_\${this.currentKlineInterval}\`;
        log.info(this.symbol, \`[WS] Subscribing to testnet Kline \${this.currentKlineInterval} stream...\`);
        this.wsTestnetKline = new WebSocket(streamUrl);
        this.wsTestnetKline.on('message', (raw) => {
            if (this.status === 'STOPPED') return;
            try {
                const data = JSON.parse(raw.toString());
                if (data.e === 'kline') {
                    this.testnetKline = data.k;
                    pushEvent('EVENT', this.symbol, \`WS Kline Update: \${data.k.i} C:\${data.k.c}\`, data);
                    broadcastToUI();
                }
            } catch(e) {}
        });
        this.wsTestnetKline.on('close', () => { this.wsTestnetKline = null; });
        this.wsTestnetKline.on('error', () => {});
    }

    startTestnetWS() {`;
repCode = repCode.replace(startRegex, newMethods);

// Add to start()
const startMethodRegex = /this\.startTestnetWS\(\);/;
repCode = repCode.replace(startMethodRegex, "this.startTestnetWS();\n        this.startTestnetTickerWS();\n        this.startTestnetKlineWS();");

// Add to stop()
const stopRegex = /if \(this\.wsTestnet\) this\.wsTestnet\.close\(\);/;
repCode = repCode.replace(stopRegex, "if (this.wsTestnet) this.wsTestnet.close();\n        if (this.wsTestnetTicker) this.wsTestnetTicker.close();\n        if (this.wsTestnetKline) this.wsTestnetKline.close();");

// Add to buildPayload
const diagRegex = /testnetLatency:  inst\.testnetLatency,/;
repCode = repCode.replace(diagRegex, "testnetLatency:  inst.testnetLatency,\n                testnetLtp:      inst.testnetLtp,\n                testnetKline:    inst.testnetKline,");

// Add HTTP endpoints
const httpRegex = /if \(req\.url\.startsWith\('\/api\/users'\)\) \{/;
const newEndpoints = `
    if (req.url.startsWith('/api/klines/history')) {
        const urlParams = new URLSearchParams(req.url.split('?')[1]);
        const symbol = urlParams.get('symbol');
        const interval = urlParams.get('interval');
        log.info(symbol, \`[REST] Fetching historical \${interval} klines...\`);
        try {
            const axios = require('axios');
            const response = await axios.get(\`https://testnet-futures-mds-read.dcxstage.com/fapi/v1/klines?symbol=\${symbol}&interval=\${interval}&limit=500\`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response.data));
        } catch(e) {
            log.error(symbol, \`[REST] Kline fetch failed: \${e.message}\`);
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (req.url.startsWith('/api/klines/subscribe') && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { symbol, interval } = JSON.parse(body);
                const inst = instances.get(symbol);
                if (inst) {
                    inst.startTestnetKlineWS(interval);
                }
            } catch(e) {}
            res.writeHead(200);
            res.end();
        });
        return;
    }

    if (req.url.startsWith('/api/users')) {`;
repCode = repCode.replace(httpRegex, newEndpoints);

fs.writeFileSync('replicator.js', repCode);

// --- 2. PATCH INDEX.HTML ---
let uiCode = fs.readFileSync('index.html', 'utf8');

// Replace Stage Mid Price to Stage LTP
uiCode = uiCode.replace('<div class="ticker-label">Stage Mid Price</div>', '<div class="ticker-label">Stage LTP</div>');
uiCode = uiCode.replace('<div class="ticker-sub">(Best ask + best bid) ÷ 2</div>', '<div class="ticker-sub">24h Ticker Websocket</div>');

// Update UI logic for t-sltp
const sltpRegex = /document\.getElementById\('t-sltp'\)\.innerText = sSpreadMid !== '—' \? sSpreadMid : '—';/;
uiCode = uiCode.replace(sltpRegex, "document.getElementById('t-sltp').innerText = diag.testnetLtp ? parseFloat(diag.testnetLtp).toFixed(diag.pricePrecision) : '—';");

// Update initTVChart
const initTvRegex = /try \{[\s\S]*?window\.tvWs = new WebSocket\([^)]+\);[\s\S]*?\} \};/m;
const newInitTv = `
            try {
                const res = await fetch(\`/api/klines/history?symbol=\${pair}&interval=\${interval}\`);
                const data = await res.json();
                
                const formattedKlines = [];
                const formattedVolume = [];
                
                data.forEach(d => {
                    const time = (d[0] / 1000) + IST_OFFSET;
                    const open = parseFloat(d[1]);
                    const high = parseFloat(d[2]);
                    const low = parseFloat(d[3]);
                    const close = parseFloat(d[4]);
                    const volume = parseFloat(d[5]);
                    const color = close >= open ? 'rgba(16, 185, 129, 0.5)' : 'rgba(244, 63, 94, 0.5)';
                    
                    formattedKlines.push({ time, open, high, low, close });
                    formattedVolume.push({ time, value: volume, color });
                });
                
                window.tvSeries.setData(formattedKlines);
                window.tvVolumeSeries.setData(formattedVolume);

                // Tell backend to subscribe to WS
                fetch('/api/klines/subscribe', { method: 'POST', body: JSON.stringify({ symbol: pair, interval: interval }) });

            } catch(e) {
                console.error('Failed to fetch historical klines', e);
            }
`;
uiCode = uiCode.replace(initTvRegex, newInitTv.trim());

// We need to inject kline SSE updates into tvSeries and tvVolumeSeries
// In the SSE message handler inside index.html:
const sseUpdateRegex = /const sBids = renderBook\('stage-bids', inst\.testnetDepth\.bids, false, diag\.pricePrecision, diag\.qtyPrecision, sMax\);/;
const klineSseUpdate = `
                    const sBids = renderBook('stage-bids', inst.testnetDepth.bids, false, diag.pricePrecision, diag.qtyPrecision, sMax);

                    // Update TV chart if kline data exists
                    if (window.tvSeries && window.tvVolumeSeries && window.activeTabSymbol === symbol && inst.diagnostics.testnetKline) {
                        const k = inst.diagnostics.testnetKline;
                        const time = (k.t / 1000) + 19800; // IST OFFSET
                        const open = parseFloat(k.o);
                        const high = parseFloat(k.h);
                        const low = parseFloat(k.l);
                        const close = parseFloat(k.c);
                        const volume = parseFloat(k.v);
                        const color = close >= open ? 'rgba(16, 185, 129, 0.5)' : 'rgba(244, 63, 94, 0.5)';
                        
                        window.tvSeries.update({ time, open, high, low, close });
                        window.tvVolumeSeries.update({ time, value: volume, color });
                    }
`;
uiCode = uiCode.replace(sseUpdateRegex, klineSseUpdate.trim());

fs.writeFileSync('index.html', uiCode);
console.log('Update Complete');
