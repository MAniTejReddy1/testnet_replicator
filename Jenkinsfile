pipeline {
    agent any

    parameters {
        string(
            name: 'SOURCE_SYMBOL',
            defaultValue: 'XRPUSDT',
            description: 'Binance symbol to mirror  (e.g. XRPUSDT, BTCUSDT, ETHUSDT)'
        )
        string(
            name: 'TARGET_SYMBOL',
            defaultValue: 'XRPQAUSDT',
            description: 'Testnet symbol to write to  (leave blank to use SOURCE_SYMBOL)'
        )
        string(
            name: 'MIN_SIZE',
            defaultValue: '50',
            description: 'Min order size in USDT'
        )
        string(
            name: 'MAX_SIZE',
            defaultValue: '100',
            description: 'Max order size in USDT'
        )
        booleanParam(
            name: 'CREATE_NEW_USERS',
            defaultValue: true,
            description: 'Generate fresh API keys for Maker and Taker users on this run?'
        )
        string(
            name: 'BUFFER_PCT',
            defaultValue: '0',
            description: 'Price buffer on all orders  (e.g. 0.01 = 0.01%)'
        )
        choice(
            name: 'ENABLE_TRADE_SYNC',
            choices: ['false', 'true'],
            description: 'Mirror Binance taker trades on testnet via IOC orders'
        )
    }

    stages {

        // ─────────────────────────────────────────────────────────────────
        stage('Validate') {
        // ─────────────────────────────────────────────────────────────────
            steps {
                script {
                    def src = params.SOURCE_SYMBOL?.trim()
                    if (!src) error("SOURCE_SYMBOL is required.")

                    def min = params.MIN_SIZE.toFloat()
                    def max = params.MAX_SIZE.toFloat()
                    if (min <= 0) error("MIN_SIZE must be greater than 0.")
                    if (max <= 0) error("MAX_SIZE must be greater than 0.")
                    if (min > max) error("MIN_SIZE (${min}) cannot exceed MAX_SIZE (${max}).")

                    env.SRC = src
                    env.TGT = params.TARGET_SYMBOL?.trim() ?: src
                    echo "Config: ${env.SRC} -> ${env.TGT} | ${min}-${max} USDT | buffer: ${params.BUFFER_PCT}% | tradeSync: ${params.ENABLE_TRADE_SYNC}"
                }
            }
        }

        // ─────────────────────────────────────────────────────────────────
        stage('Kill existing run for same symbol') {
        // ─────────────────────────────────────────────────────────────────
            steps {
                script {
                    // Kill any previous replicator runs
                    sh "pkill -f 'node replicator.js' || true"
                    sh "pkill -f 'node reporter.js' || true"
                    sleep(time: 3, unit: 'SECONDS')
                    echo "Previous instances stopped."
                }
            }
        }

        // ─────────────────────────────────────────────────────────────────
        stage('Checkout') {
        // ─────────────────────────────────────────────────────────────────
            steps {
                git url: 'https://github.com/MAniTejReddy1/testnet_replicator.git', branch: 'main'
            }
        }

        // ─────────────────────────────────────────────────────────────────
        stage('Install dependencies') {
        // ─────────────────────────────────────────────────────────────────
            steps {
                // Install replicator deps + reporter deps
                sh 'npm install'
            }
        }

        // ─────────────────────────────────────────────────────────────────
        stage('Generate Test Credentials') {
        // ─────────────────────────────────────────────────────────────────
            steps {
                script {
                    if (params.CREATE_NEW_USERS) {
                        echo "Creating new users and API keys..."
                        sh 'node scripts/setup-creds.js'
                    } else {
                        echo "CREATE_NEW_USERS is false. Using repo hardcoded user credentials."
                        // Create empty creds.env so readFile won't fail
                        sh 'touch creds.env'
                    }
                }
            }
        }

        // ─────────────────────────────────────────────────────────────────
        stage('Run Replicator') {
        // ─────────────────────────────────────────────────────────────────
            steps {
                script {
                    echo "Starting Replicator..."

                    // ── Relax Jenkins CSP so JS in userContent can fetch state.json ──
                    // Jenkins default CSP blocks all scripts in /userContent/ files.
                    // This must be done here (in the pipeline script) each build.
                    try {
                        System.setProperty(
                            "hudson.model.DirectoryBrowserSupport.CSP",
                            "default-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
                            "img-src 'self' data:; " +
                            "font-src * data:; " +
                            "connect-src 'self' https:; " +
                            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
                            "script-src 'self' 'unsafe-inline' 'unsafe-eval';"
                        )
                        echo "Jenkins CSP relaxed — userContent JS is now permitted"
                    } catch(err) {
                        error("FATAL: Could not relax Jenkins CSP. You MUST go to 'Manage Jenkins' -> 'In-process Script Approval' and approve the System.setProperty script. Error: ${err.message}")
                    }

                    // Clean up old allure results to prevent merging with previous runs

                    sh 'rm -rf allure-results allure-report reporter.log'
                    def sources = env.SRC.split(',')
                    def targets = env.TGT.split(',')
                    def configObjs = []
                    for (int i = 0; i < sources.size(); i++) {
                        def src = sources[i].trim()
                        def tgt = targets.size() > i ? targets[i].trim() : src
                        configObjs.add("""{
  "sourceSymbol": "${src}",
  "targetSymbol": "${tgt}",
  "minSize": ${params.MIN_SIZE},
  "maxSize": ${params.MAX_SIZE},
  "depthLevels": 10,
  "qtyChangeTolerance": 0.25,
  "enableTradeSync": ${params.ENABLE_TRADE_SYNC},
  "bufferPct": ${params.BUFFER_PCT},
  "cancelOnStop": true,
  "tradeDelayMs": 0
}""")
                    }
                    def config = "[" + configObjs.join(",") + "]"
                    // Load the dynamically generated credentials
                    def credsFile = readFile('creds.env').trim()
                    def dynamicCreds = credsFile ? credsFile.split('\n').toList() : []
                    def envVars = ["MARKET_CONFIGS=${config}", "REPORTER_PORT=3001"] + dynamicCreds

                    // ── Serve UI via Jenkins /userContent/ (port 80 — no firewall needed) ──
                    def jenkinsHome = env.JENKINS_HOME ?: '/var/lib/jenkins'
                    def uiDir = "${jenkinsHome}/userContent/replicator-ui"
                    def jenkinsUrl = (env.JENKINS_URL ?: "http://localhost:8080/").replaceAll('/+$', '')
                    def uiUrl = "${jenkinsUrl}/userContent/replicator-ui/index.html?v=${env.BUILD_NUMBER}"

                    // Write the polling UI to userContent so it's served on Jenkins' own port
                    sh """
mkdir -p ${uiDir}
cat > ${uiDir}/index.html << 'HTMLEOF'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Replication Terminal — CoinDCX HPO</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{--bg:#03040a;--panel:#080c14;--border:rgba(255,255,255,0.055);--bid:#10b981;--ask:#f43f5e;--cyan:#06b6d4;--yellow:#eab308;--purple:#a855f7}
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{font-family:'JetBrains Mono',monospace;background:var(--bg);color:#b8c4d4;font-size:11px;overflow-x:hidden}
  ::-webkit-scrollbar{width:3px;height:3px} ::-webkit-scrollbar-track{background:transparent} ::-webkit-scrollbar-thumb{background:rgba(6,182,212,.22);border-radius:99px}
  .panel{background:var(--panel);border:1px solid var(--border);border-radius:12px}
  .panel-accent{border-color:rgba(6,182,212,.18)}
  .hdr-bar{height:2px;background:linear-gradient(90deg,#06b6d4,#8b5cf6,#f43f5e,#06b6d4);background-size:300% 100%;animation:shimmer 5s linear infinite}
  @keyframes shimmer{to{background-position:-300% 0}}
  .dot-live{background:#10b981;box-shadow:0 0 0 0 rgba(16,185,129,.7);animation:pulse-g 1.6s ease-out infinite}
  .dot-paused{background:#eab308} .dot-dead{background:#f43f5e}
  @keyframes pulse-g{70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}
  .d-row{display:grid;grid-template-columns:1fr 1fr 1fr;align-items:center;padding:2px 10px;position:relative;border-radius:3px}
  .d-row:hover{background:rgba(255,255,255,.03)}
  .d-bar{position:absolute;top:0;bottom:0;opacity:.13;border-radius:3px;pointer-events:none;transition:width .22s}
  .d-bar-r{right:0;left:auto} .d-bar-l{left:0;right:auto}
  .d-spread{flex-shrink:0;text-align:center;padding:4px 0;font-size:10px;color:#4b5563;border-top:1px solid rgba(255,255,255,.04);border-bottom:1px solid rgba(255,255,255,.04);margin:2px 0}
  @keyframes fG{50%{color:#10b981}} @keyframes fR{50%{color:#f43f5e}}
  .fl-g{animation:fG .35s ease} .fl-r{animation:fR .35s ease}
  @keyframes slideIn{from{opacity:0;transform:translateX(6px)}to{opacity:1;transform:none}}
  .tr-row{display:grid;grid-template-columns:75px 1fr 68px 52px;align-items:center;padding:4px 10px;border-bottom:1px solid rgba(255,255,255,.03);border-radius:3px;font-size:10px}
  .tab{padding:4px 10px;border-bottom:2px solid transparent;color:#4b5563;cursor:pointer;transition:all .18s;font-size:10px}
  .tab.on{border-color:var(--cyan);color:var(--cyan)}
  .sym-tab{padding:6px 14px;border-radius:6px;color:#6b7280;font-weight:600;cursor:pointer;transition:all .2s}
  .sym-tab.on{background:rgba(6,182,212,.1);color:var(--cyan);border:1px solid rgba(6,182,212,.2)}
  .badge{font-size:9px;padding:2px 7px;border-radius:99px;font-weight:700;letter-spacing:.05em}
  .badge-ok{background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.25);color:#34d399}
  .badge-fail{background:rgba(244,63,94,.12);border:1px solid rgba(244,63,94,.25);color:#fb7185}
  .chip{background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:8px;padding:6px 12px;transition:border-color .18s,transform .12s;cursor:default;text-align:center;min-width:80px}
  .chip:hover{border-color:rgba(6,182,212,.2);transform:translateY(-1px)}
  .chip-label{font-size:9px;color:#4b5563;text-transform:uppercase;letter-spacing:.07em}
  .chip-val{font-size:12px;font-weight:700;margin-top:2px}
  .ticker-card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px 16px;flex:1}
  .ticker-label{font-size:9px;color:#4b5563;text-transform:uppercase;letter-spacing:.07em}
  .ticker-val{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:3px}
  .ticker-sub{font-size:9px;color:#374151;margin-top:2px}
  .hbar{height:2px;border-radius:99px;background:rgba(255,255,255,.06);overflow:hidden;margin-top:6px}
  .hbar-fill{height:100%;border-radius:99px;transition:width .4s,background .3s}
  .err-banner{background:rgba(244,63,94,.08);border:1px solid rgba(244,63,94,.2);color:#fb7185;border-radius:6px;padding:6px 10px;font-size:10px;margin:8px 12px 0}
  .book-hdr{display:grid;grid-template-columns:1fr 1fr 1fr;padding:4px 10px;font-size:9px;color:#374151;text-transform:uppercase;letter-spacing:.07em;border-bottom:1px solid rgba(255,255,255,.04)}
  .sec-label{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:#374151}
  .sec-title{font-size:11px;font-weight:700;color:#e2e8f0;margin-top:1px}
  .flag-pill{font-size:9px;padding:2px 8px;border-radius:99px;font-weight:700;letter-spacing:.04em}
  .flag-on{background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.25);color:#34d399}
  .flag-off{background:rgba(244,63,94,.1);border:1px solid rgba(244,63,94,.25);color:#fb7185}
  .flag-buf{background:rgba(234,179,8,.1);border:1px solid rgba(234,179,8,.25);color:#fde047}
  .c-emerald{color:#10b981} .c-rose{color:#f43f5e} .c-yellow{color:#eab308} .c-yellow4{color:#facc15} .fw-bold{font-weight:700}
  #poll-status{font-size:9px;color:#374151;letter-spacing:.06em}
</style>
</head>
<body>
<div id="csp-warning" style="background:#f43f5e;color:white;padding:12px;text-align:center;font-weight:bold;z-index:9999;position:relative;font-size:12px;">
  ⚠️ WARNING: JavaScript is disabled or blocked by Jenkins CSP. The UI will not update. Please go to Manage Jenkins → In-process Script Approval and approve the script.
</div>
<div class="hdr-bar"></div>
<header style="background:var(--panel);border-bottom:1px solid var(--border);padding:8px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;position:sticky;top:0;z-index:30;">
  <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
    <div style="position:relative;width:10px;height:10px;"><div id="dot" class="dot-dead" style="width:10px;height:10px;border-radius:50%;position:absolute;"></div></div>
    <div><span style="font-weight:700;color:#f1f5f9;font-size:12px;letter-spacing:.08em;">MULTI-MARKET REPLICATOR</span><span style="color:#374151;font-size:9px;margin-left:8px;letter-spacing:.06em;">v5 · HPO STAGING</span></div>
  </div>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;" id="symbol-tabs"></div>
  <div style="display:flex;gap:8px;align-items:center;">
    <span id="poll-status">⏳ POLLING...</span>
    <div class="chip"><div class="chip-label">Engine</div><div class="chip-val" id="c-eng"><span class="c-rose fw-bold">OFFLINE</span></div></div>
    <div class="chip"><div class="chip-label">IST</div><div class="chip-val" id="c-clock" style="color:#4b5563;font-size:10px;">—</div></div>
  </div>
</header>
<div style="padding:10px 20px;display:flex;justify-content:flex-end;align-items:center;background:#06090f;border-bottom:1px solid var(--border);">
  <div style="display:flex;gap:12px;font-size:10px;align-items:center;flex-wrap:wrap;">
    <div><span style="color:#6b7280">PAIR:</span> <span id="c-pair" style="font-weight:700;color:#e2e8f0">—</span></div>
    <div><span style="color:#6b7280">BINANCE RTT:</span> <span id="c-bping" style="font-weight:700;color:#eab308">0ms</span></div>
    <div><span style="color:#6b7280">STAGING RTT:</span> <span id="c-sping" style="font-weight:700;color:#06b6d4">0ms</span></div>
    <div><span style="color:#6b7280">SYNC:</span> <span id="c-sync" style="font-weight:700;color:#10b981">100%</span></div>
    <div id="flag-tradeSync" class="flag-pill flag-off">TRADE SYNC</div>
    <div id="flag-cancelStop" class="flag-pill flag-off">CANCEL ON STOP</div>
    <div id="flag-buffer" class="flag-pill flag-buf">BUF 0%</div>
    <div id="flag-delay" class="flag-pill" style="background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.25);color:#c084fc;">DELAY 0ms</div>
  </div>
</div>
<div style="display:flex;gap:10px;padding:12px 20px 0;">
  <div class="ticker-card panel-accent"><div class="ticker-label">Binance LTP</div><div class="ticker-val" id="t-bltp" style="color:var(--yellow)">—</div><div class="ticker-sub">Last agg-trade price</div></div>
  <div class="ticker-card"><div class="ticker-label">Stage Mid Price</div><div class="ticker-val" id="t-sltp" style="color:var(--cyan)">—</div><div class="ticker-sub">(Best ask + best bid) ÷ 2</div></div>
  <div class="ticker-card"><div class="ticker-label">Basis Drift</div><div style="display:flex;align-items:baseline;gap:8px;margin-top:3px;"><div class="ticker-val" id="t-drift" style="font-size:18px;">—</div><div id="t-dpct" style="font-size:11px;color:#6b7280;">—</div></div><div class="hbar"><div class="hbar-fill" id="drift-bar" style="width:0%;background:var(--cyan)"></div></div></div>
  <div class="ticker-card"><div class="ticker-label">Binance Spread</div><div style="display:flex;align-items:baseline;gap:8px;margin-top:3px;"><div class="ticker-val" id="t-bspread" style="font-size:18px;color:var(--purple)">—</div><div id="t-bspct" style="font-size:11px;color:#6b7280;">—</div></div><div class="ticker-sub">Best ask − Best bid</div></div>
</div>
<div style="display:grid;grid-template-columns:1fr 1fr 340px;gap:10px;padding:10px 20px;">
  <div class="panel" style="display:flex;flex-direction:column;height:500px;overflow:hidden;">
    <div style="padding:10px 12px 8px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;"><div><div class="sec-label">Source</div><div class="sec-title" style="color:var(--yellow)">Binance Perpetual</div></div><div id="bin-spread-badge" style="font-size:9px;padding:2px 8px;border-radius:99px;background:rgba(168,85,247,.08);border:1px solid rgba(168,85,247,.18);color:var(--purple);">Spread —</div></div>
    <div class="book-hdr"><span>Price</span><span style="text-align:center;">Size</span><span style="text-align:right;">Total</span></div>
    <div style="flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column-reverse;" id="bin-asks"></div><div class="d-spread" id="bin-spread-mid">Spread —</div><div style="flex:1;min-height:0;overflow-y:auto;" id="bin-bids"></div>
  </div>
  <div class="panel panel-accent" style="display:flex;flex-direction:column;height:500px;overflow:hidden;">
    <div style="padding:10px 12px 8px;border-bottom:1px solid rgba(6,182,212,0.12);display:flex;justify-content:space-between;align-items:center;"><div><div class="sec-label">Target · Testnet</div><div class="sec-title" style="color:var(--cyan)">Stage Orderbook</div></div><div id="stage-spread-badge" style="font-size:9px;padding:2px 8px;border-radius:99px;background:rgba(6,182,212,.07);border:1px solid rgba(6,182,212,.15);color:var(--cyan);">Spread —</div></div>
    <div class="book-hdr"><span>Price</span><span style="text-align:center;">Size</span><span style="text-align:right;">Total</span></div>
    <div style="flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column-reverse;" id="stage-asks"></div><div class="d-spread" id="stage-spread-mid">Spread —</div><div style="flex:1;min-height:0;overflow-y:auto;" id="stage-bids"></div>
  </div>
  <div class="panel" style="display:flex;flex-direction:column;height:500px;overflow:hidden;">
    <div style="padding:10px 12px 8px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;"><div><div class="sec-label">Execution Sync</div><div class="sec-title" style="color:var(--purple);">LTP Cross Stream</div></div><div style="display:flex;gap:6px;"><span id="t-trok" class="badge badge-ok">0 OK</span><span id="t-trfail" class="badge badge-fail">0 FAIL</span></div></div>
    <div style="display:flex;border-bottom:1px solid var(--border);padding:0 8px;"><button class="tab on" data-f="all">All</button><button class="tab" data-f="ok">Filled</button><button class="tab" data-f="fail">Failed</button></div>
    <div style="flex:1;overflow-y:auto;min-height:0;" id="trade-stream"><div style="text-align:center;padding:40px 0;color:#374151;font-size:10px;text-transform:uppercase;letter-spacing:.08em;">Awaiting trades...</div></div>
  </div>
</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:0 20px 20px;">
  <div class="panel" style="overflow:hidden;">
    <div style="padding:10px 14px 8px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;"><div style="display:flex;align-items:center;gap:8px;"><div style="width:7px;height:7px;border-radius:50%;background:var(--cyan);flex-shrink:0;"></div><div><div class="sec-label">User 1 · Maker / Orderbook Keeper</div><div class="sec-title" id="u1-title">Global Portfolio</div></div></div><div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;" id="u1-chips"></div></div>
    <div id="u1-err" class="err-banner" style="display:none;"></div>
    <div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;"><thead><tr style="font-size:9px;color:#374151;text-transform:uppercase;letter-spacing:.07em;border-bottom:1px solid rgba(255,255,255,.04);"><th style="padding:6px 14px;text-align:left;font-weight:500;">Symbol</th><th style="padding:6px 8px;text-align:right;font-weight:500;">Lev</th><th style="padding:6px 8px;text-align:right;font-weight:500;">Margin</th><th style="padding:6px 8px;text-align:right;font-weight:500;">Size</th><th style="padding:6px 8px;text-align:right;font-weight:500;">Unreal. PnL</th><th style="padding:6px 8px;text-align:right;font-weight:500;">Entry</th><th style="padding:6px 8px;text-align:right;font-weight:500;">Mark</th><th style="padding:6px 14px;text-align:right;font-weight:500;">Liq.</th></tr></thead><tbody id="u1-body"><tr><td colspan="8" style="text-align:center;padding:28px 0;color:#374151;font-size:10px;text-transform:uppercase;">No active positions</td></tr></tbody></table></div>
  </div>
  <div class="panel" style="overflow:hidden;">
    <div style="padding:10px 14px 8px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;"><div style="display:flex;align-items:center;gap:8px;"><div style="width:7px;height:7px;border-radius:50%;background:var(--yellow);flex-shrink:0;"></div><div><div class="sec-label">User 2 · Taker / LTP Consumer</div><div class="sec-title" id="u2-title">Global Portfolio</div></div></div><div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;" id="u2-chips"></div></div>
    <div id="u2-err" class="err-banner" style="display:none;"></div>
    <div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;"><thead><tr style="font-size:9px;color:#374151;text-transform:uppercase;letter-spacing:.07em;border-bottom:1px solid rgba(255,255,255,.04);"><th style="padding:6px 14px;text-align:left;font-weight:500;">Symbol</th><th style="padding:6px 8px;text-align:right;font-weight:500;">Lev</th><th style="padding:6px 8px;text-align:right;font-weight:500;">Margin</th><th style="padding:6px 8px;text-align:right;font-weight:500;">Size</th><th style="padding:6px 8px;text-align:right;font-weight:500;">Unreal. PnL</th><th style="padding:6px 8px;text-align:right;font-weight:500;">Entry</th><th style="padding:6px 8px;text-align:right;font-weight:500;">Mark</th><th style="padding:6px 14px;text-align:right;font-weight:500;">Liq.</th></tr></thead><tbody id="u2-body"><tr><td colspan="8" style="text-align:center;padding:28px 0;color:#374151;font-size:10px;text-transform:uppercase;">No active positions</td></tr></tbody></table></div>
  </div>
</div>
<script>
(function(){
  document.getElementById('csp-warning').style.display='none';
  var POLL_INTERVAL = 2000;
  var activeTab = null, cache = {}, globalData = null, tradeFilter = 'all', showBars = true;
  var pPrec = 4, qPrec = 1, knownTrades = new Set(), prevBinLtp = null;

  setInterval(function(){
    var el=document.getElementById('c-clock');
    if(el) el.textContent=new Date().toLocaleTimeString('en-US',{timeZone:'Asia/Kolkata',hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})+' IST';
  },1000);

  document.querySelectorAll('.tab').forEach(function(btn){
    btn.onclick=function(){
      document.querySelectorAll('.tab').forEach(function(b){b.classList.remove('on');});
      btn.classList.add('on'); tradeFilter=btn.getAttribute('data-f');
      document.getElementById('trade-stream').innerHTML=''; knownTrades.clear();
      if(cache[activeTab]) updateTrades(cache[activeTab].syncedTrades);
    };
  });

  var fmt=function(v,d){return parseFloat(v||0).toFixed(d);};
  function fmtK(v){var n=parseFloat(v||0);return n>=1000?(n/1000).toFixed(1)+'K':n.toFixed(0);}

  function renderBook(askEl,bidEl,spBadge,spMid,asks,bids){
    var maxA=(asks||[]).reduce(function(m,r){return Math.max(m,parseFloat(r[1]));},0.0001);
    var maxB=(bids||[]).reduce(function(m,r){return Math.max(m,parseFloat(r[1]));},0.0001);
    function row(r,side,maxQ){
      var pct=Math.min(100,(parseFloat(r[1])/maxQ)*100).toFixed(1);
      var isA=side==='ask';
      var col=isA?'var(--ask)':'var(--bid)';
      var barCol=isA?'#f43f5e':'#10b981';
      var total=(parseFloat(r[0])*parseFloat(r[1])).toFixed(0);
      var barHtml=showBars?'<div class="d-bar d-bar-'+(isA?'r':'l')+'" style="background:'+barCol+';width:'+pct+'%"></div>':'';
      return '<div class="d-row"><span style="color:'+col+';font-weight:600;">'+fmt(r[0],pPrec)+'</span><span style="text-align:center;color:#6b7280;">'+fmt(r[1],qPrec)+'</span><span style="text-align:right;color:#374151;">'+fmtK(total)+'</span>'+barHtml+'</div>';
    }
    askEl.innerHTML=asks&&asks.length?asks.map(function(r){return row(r,'ask',maxA);}).join(''):'<div style="text-align:center;padding:16px 0;color:#374151;font-size:10px;">No asks</div>';
    bidEl.innerHTML=bids&&bids.length?bids.map(function(r){return row(r,'bid',maxB);}).join(''):'<div style="text-align:center;padding:16px 0;color:#374151;font-size:10px;">No bids</div>';
    if(asks&&asks[0]&&bids&&bids[0]){
      var spN=parseFloat(asks[0][0])-parseFloat(bids[0][0]);
      var spP=parseFloat(asks[0][0])>0?((spN/parseFloat(asks[0][0]))*100).toFixed(3):'0.000';
      var txt='Spread '+spN.toFixed(pPrec)+' ('+spP+'%)';
      if(spBadge)spBadge.textContent=txt; if(spMid)spMid.textContent=txt;
    }
  }

  function updateTrades(trades){
    var el=document.getElementById('trade-stream');
    if(!trades||!trades.length){el.innerHTML='<div style="text-align:center;padding:40px 0;color:#374151;font-size:10px;text-transform:uppercase;letter-spacing:.08em;">Awaiting trades...</div>';knownTrades.clear();return;}
    var newItems=trades.filter(function(t){return !knownTrades.has(t.id);});
    if(newItems.length>0){
      if(el.innerHTML.includes('Awaiting')||el.innerHTML.includes('Loading'))el.innerHTML='';
      newItems.slice().reverse().forEach(function(t){
        knownTrades.add(t.id);
        if(tradeFilter==='ok'&&!t.success)return;
        if(tradeFilter==='fail'&&t.success)return;
        var badge=t.success?'<span class="badge badge-ok">FILLED</span>':'<span class="badge badge-fail">FAILED</span>';
        var d=document.createElement('div');
        d.className='tr-row'; d.style.animation='slideIn .22s ease';
        d.innerHTML='<span style="color:#4b5563;">'+t.time+'</span><span style="color:var(--yellow);font-weight:600;">'+parseFloat(t.price).toFixed(pPrec)+'</span><span style="color:#6b7280;">'+parseFloat(t.stageQty).toFixed(qPrec)+'</span>'+badge;
        el.insertBefore(d,el.firstChild);
      });
      while(el.children.length>50)el.removeChild(el.lastChild);
    }
  }

  function chipHtml(label,value,color){return '<div class="chip" style="min-width:70px;"><div class="chip-label">'+label+'</div><div class="chip-val" style="color:'+color+';font-size:10px;">'+value+'</div></div>';}

  function renderPortfolio(data,errEl,chipsEl,titleEl,bodyEl){
    if(!data)return;
    if(data.error){errEl.style.display='block';errEl.textContent='⚠ '+data.error;}else{errEl.style.display='none';}
    var wallet=parseFloat(data.walletBalance||0),avail=parseFloat(data.availableBalance||0);
    var locked=Math.max(0,wallet-avail),pnl=parseFloat(data.unrealizedProfit||0);
    chipsEl.innerHTML=chipHtml('Wallet',wallet.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+' U','#e2e8f0')+chipHtml('Available',avail.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+' U','#10b981')+chipHtml('Locked',locked.toFixed(2)+' U','#f43f5e')+chipHtml('PnL',(pnl>=0?'+':'')+pnl.toFixed(2)+' U',pnl>=0?'#10b981':'#f43f5e')+chipHtml('Orders',String(data.openOrdersCount||0),'var(--cyan)');
    var pos=data.positions||[];
    titleEl.textContent='Global Portfolio ('+pos.length+')';
    if(!pos.length){bodyEl.innerHTML='<tr><td colspan="8" style="text-align:center;padding:24px 0;color:#374151;font-size:10px;text-transform:uppercase;">No active positions</td></tr>';return;}
    bodyEl.innerHTML=pos.map(function(p){
      var sideBg=p.side==='LONG'?'background:rgba(16,185,129,.09);border:1px solid rgba(16,185,129,.2);color:#34d399;':'background:rgba(244,63,94,.09);border:1px solid rgba(244,63,94,.2);color:#fb7185;';
      var pnlV=parseFloat(p.unrealizedPnL),pnlCol=pnlV>=0?'#34d399':'#fb7185',pnlSign=pnlV>=0?'+':'';
      return '<tr style="border-bottom:1px solid rgba(255,255,255,.03);"><td style="padding:7px 14px;"><span style="font-weight:700;color:#e2e8f0;">'+p.symbol+'</span><span style="margin-left:5px;font-size:9px;padding:1px 6px;border-radius:99px;'+sideBg+'">'+p.side+'</span></td><td style="padding:7px 8px;text-align:right;color:#6b7280;">'+p.leverage+'×</td><td style="padding:7px 8px;text-align:right;color:var(--cyan);">'+parseFloat(p.margin).toFixed(2)+'</td><td style="padding:7px 8px;text-align:right;color:#9ca3af;">'+p.size+'</td><td style="padding:7px 8px;text-align:right;font-weight:700;color:'+pnlCol+';">'+pnlSign+pnlV.toFixed(2)+'</td><td style="padding:7px 8px;text-align:right;color:#6b7280;">'+p.entryPrice+'</td><td style="padding:7px 8px;text-align:right;color:#6b7280;">'+p.markPrice+'</td><td style="padding:7px 14px;text-align:right;color:var(--yellow);">'+p.liqPrice+'</td></tr>';
    }).join('');
  }

  function selectTab(sym){
    activeTab=sym; tradeFilter='all';
    document.querySelectorAll('.sym-tab').forEach(function(t){t.classList.remove('on');});
    var el=document.querySelector('.sym-tab[data-sym="'+sym+'"]');
    if(el)el.classList.add('on');
    document.getElementById('trade-stream').innerHTML='<div style="text-align:center;padding:40px 0;color:#374151;font-size:10px;text-transform:uppercase;">Loading...</div>';
    knownTrades.clear();
    if(cache[sym]&&globalData)render(cache[sym],globalData);
  }
  window.selectTab=selectTab;

  function render(inst,data){
    if(!inst)return;
    var diag=inst.diagnostics||{};
    pPrec=diag.pricePrecision!==undefined?diag.pricePrecision:4;
    qPrec=diag.qtyPrecision!==undefined?diag.qtyPrecision:1;
    var dot=document.getElementById('dot'),st=document.getElementById('c-eng');
    if(inst.status==='RUNNING'){dot.className='dot-live';st.innerHTML="<span class='c-emerald fw-bold'>RUNNING</span>";}
    else if(inst.status==='PAUSED'){dot.className='dot-paused';st.innerHTML="<span class='c-yellow fw-bold'>PAUSED</span>";}
    else{dot.className='dot-dead';st.innerHTML="<span class='c-rose fw-bold'>STOPPED</span>";}
    document.getElementById('c-bping').textContent=(diag.binanceLatency||0)+'ms';
    document.getElementById('c-sping').textContent=(diag.testnetLatency||0)+'ms';
    document.getElementById('c-sync').textContent=(diag.syncRatio||'100')+'%';
    var srcStr=(diag.sourceSymbol&&diag.sourceSymbol!==activeTab)?' (SRC: '+diag.sourceSymbol+')':'';
    document.getElementById('c-pair').textContent=activeTab+srcStr;
    var tsEl=document.getElementById('flag-tradeSync'),csEl=document.getElementById('flag-cancelStop');
    var bufEl=document.getElementById('flag-buffer'),delEl=document.getElementById('flag-delay');
    if(diag.enableTradeSync){tsEl.textContent='TRADE SYNC ON';tsEl.className='flag-pill flag-on';}else{tsEl.textContent='TRADE SYNC OFF';tsEl.className='flag-pill flag-off';}
    if(diag.cancelOnStop){csEl.textContent='CANCEL ON STOP';csEl.className='flag-pill flag-on';}else{csEl.textContent='KEEP ON STOP';csEl.className='flag-pill flag-off';}
    var buf=parseFloat(diag.bufferPct||0);bufEl.textContent=buf>0?'BUF '+buf+'%':'NO BUFFER';
    var delay=parseInt(diag.tradeDelayMs||0);delEl.textContent=delay>0?'DELAY '+delay+'ms':'DELAY OFF';
    var binLtp=diag.binanceLtp||'0.0000';document.getElementById('t-bltp').textContent=fmt(binLtp,pPrec);
    var sa=inst.testnetDepth.asks,sb=inst.testnetDepth.bids;
    var stageLtp=(sa&&sa[0]&&sb&&sb[0])?((parseFloat(sa[0][0])+parseFloat(sb[0][0]))/2).toFixed(pPrec):binLtp;
    document.getElementById('t-sltp').textContent=fmt(stageLtp,pPrec);
    var dAbs=Math.abs(parseFloat(binLtp)-parseFloat(stageLtp)).toFixed(pPrec);
    var dPct=parseFloat(binLtp)>0?((dAbs/parseFloat(binLtp))*100).toFixed(3):'0.000';
    document.getElementById('t-drift').textContent=dAbs;document.getElementById('t-dpct').textContent='('+dPct+'%)';
    var db=document.getElementById('drift-bar'),dp=parseFloat(dPct);
    db.style.width=Math.min(100,dp*1000)+'%';db.style.background=dp>0.05?'#f43f5e':dp>0.02?'#eab308':'var(--cyan)';
    var ba=inst.binanceDepth.asks,bb=inst.binanceDepth.bids;
    if(ba&&ba[0]&&bb&&bb[0]){var spN=parseFloat(ba[0][0])-parseFloat(bb[0][0]);var sp=spN.toFixed(pPrec);var spp=parseFloat(ba[0][0])>0?((spN/parseFloat(ba[0][0]))*100).toFixed(3):'0.000';document.getElementById('t-bspread').textContent=sp;document.getElementById('t-bspct').textContent='('+spp+'%)';}
    var ok=(inst.syncedTrades||[]).filter(function(t){return t.success;}).length;
    var fail=(inst.syncedTrades||[]).filter(function(t){return !t.success;}).length;
    document.getElementById('t-trok').textContent=ok+' OK';document.getElementById('t-trfail').textContent=fail+' FAIL';
    renderBook(document.getElementById('bin-asks'),document.getElementById('bin-bids'),document.getElementById('bin-spread-badge'),document.getElementById('bin-spread-mid'),inst.binanceDepth.asks,inst.binanceDepth.bids);
    renderBook(document.getElementById('stage-asks'),document.getElementById('stage-bids'),document.getElementById('stage-spread-badge'),document.getElementById('stage-spread-mid'),inst.testnetDepth.asks,inst.testnetDepth.bids);
    updateTrades(inst.syncedTrades);
    renderPortfolio(data.user1Portfolio,document.getElementById('u1-err'),document.getElementById('u1-chips'),document.getElementById('u1-title'),document.getElementById('u1-body'));
    renderPortfolio(data.user2Portfolio,document.getElementById('u2-err'),document.getElementById('u2-chips'),document.getElementById('u2-title'),document.getElementById('u2-body'));
  }

  var pollErrors=0;
  function poll(){
    fetch('state.json?_='+Date.now())
      .then(function(r){
        // 404 = state.json not written yet (replicator still starting)
        if(r.status===404||r.status===0){
          var ps=document.getElementById('poll-status');
          if(ps){ps.textContent='⏳ STARTING...';ps.style.color='#eab308';}
          var dot=document.getElementById('dot'),st=document.getElementById('c-eng');
          if(dot)dot.className='dot-paused';
          if(st)st.innerHTML="<span class='c-yellow fw-bold'>STARTING...</span>";
          var tc=document.getElementById('symbol-tabs');
          if(tc)tc.innerHTML='<span style="color:#eab308;font-size:10px;letter-spacing:.06em;">⏳ Waiting for replicator to start...</span>';
          return null;
        }
        return r.json();
      })
      .then(function(data){
        if(!data)return; // 404 handled above
        pollErrors=0;
        var ps=document.getElementById('poll-status');
        if(ps){ps.textContent='🟢 LIVE';ps.style.color='#10b981';}
        cache=data.instances||{};globalData=data;
        var syms=Object.keys(cache);
        var tc=document.getElementById('symbol-tabs');
        if(syms.length===0){tc.innerHTML='<span style="color:#374151;font-size:10px;letter-spacing:.06em;">Waiting for engine...</span>';return;}
        if(!activeTab||!cache[activeTab])selectTab(syms[0]);
        tc.innerHTML=syms.map(function(sym){
          var isA=sym===activeTab;
          var sc=cache[sym].status==='RUNNING'?'#10b981':cache[sym].status==='PAUSED'?'#eab308':'#f43f5e';
          return '<div class="sym-tab'+(isA?' on':'')+'" data-sym="'+sym+'" onclick="selectTab(\''+sym+'\')"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:'+sc+';margin-right:6px;"></span>'+sym+'</div>';
        }).join('');
        if(activeTab&&cache[activeTab])render(cache[activeTab],data);
      })
      .catch(function(){
        pollErrors++;
        var ps=document.getElementById('poll-status');
        if(ps){ps.textContent='🔴 OFFLINE ('+pollErrors+')';ps.style.color='#f43f5e';}
        var dot=document.getElementById('dot'),st=document.getElementById('c-eng');
        if(dot)dot.className='dot-dead';
        if(st)st.innerHTML="<span class='c-rose fw-bold'>DISCONNECTED</span>";
      });
  }

  poll();
  setInterval(poll,POLL_INTERVAL);
})();
</script>
</body>
</html>
HTMLEOF
                    echo "Replicator UI written to ${uiDir}/index.html"
                    """

                    echo "========================================================="
                    echo "  REPLICATOR WEB UI IS ACCESSIBLE AT:"
                    echo "  ${uiUrl}"
                    echo "========================================================="
                    currentBuild.description = "Replicator UI: <a href='${uiUrl}' target='_blank'>${uiUrl}</a>"

                    withEnv(envVars + ["STATE_FILE_PATH=${uiDir}/state.json"]) {
                        // replicator.js reads STATE_FILE_PATH and writes state.json
                        // directly on every broadcastToUI() call — no curl poller needed.
                        sh """

# Diagnostics — confirm env vars are visible
echo "[DIAG] STATE_FILE_PATH=$STATE_FILE_PATH"
echo "[DIAG] JENKINS_HOME=$JENKINS_HOME"
echo "[DIAG] UI dir contents:"
ls -la $(dirname $STATE_FILE_PATH) 2>/dev/null || echo "[DIAG] UI dir does not exist yet"

# 1. Start reporter
node reporter.js > reporter.log 2>&1 &
echo "Reporter started"

# 2. Start replicator — reads STATE_FILE_PATH env var and writes state.json directly
node replicator.js &
REPLICATOR_PID=\$!
echo "Replicator started (PID \$REPLICATOR_PID)"
echo "[DIAG] Waiting 15s then checking if state.json was written..."
sleep 15
if [ -f "\$STATE_FILE_PATH" ]; then
  echo "[DIAG] ✅ state.json EXISTS (\$(wc -c < \$STATE_FILE_PATH) bytes)"
else
  echo "[DIAG] ❌ state.json NOT found — STATE_FILE_PATH=\$STATE_FILE_PATH"
fi

# 3. Keep pipeline alive until Jenkins aborts the build
wait \$REPLICATOR_PID
"""
                    }

                }
            }
        }
    }


    // ─────────────────────────────────────────────────────────────────────
    // POST — always runs, even on abort
    // ─────────────────────────────────────────────────────────────────────
    post {
        always {
            script {
                echo "=== POST: Stopping all processes ==="
                // Gracefully stop the reporter first to allow it to flush results
                sh "pkill -f 'node reporter.js' || true"
                sh "pkill -f 'node replicator.js' || true"
                // Stop the state poller background loop
                sh "pkill -f 'replicator-poller' || pkill -f 'localhost:3000/api/snapshot' || true"
                sleep(time: 3, unit: 'SECONDS') // Wait for files to be written

                echo "=== POST: Preparing Allure results ==="
                // Ensure the final metadata files are written
                sh 'node reporter.js --flush || true'

                // Print reporter log for debugging, especially if results are missing
                echo "=== Replicator log tail ==="
                sh 'tail -50 reporter.log || true'

                // Let the Allure Plugin handle the report generation and publishing
                echo "Archiving Allure results..."
                allure includeProperties: false, results: [[path: 'allure-results']]
            }

            // Archive the raw allure-results JSON for re-processing if needed
            archiveArtifacts(
                artifacts:     'allure-results/*.json, reporter.log',
                allowEmptyArchive: true
            )
        }

        aborted {
            echo "Build aborted. Open orders being cancelled by replicator (cancelOnStop: true)."
        }
        failure {
            echo "Build failed. Check Validate stage or reporter.log for details."
        }
        success {
            echo "Replicator exited cleanly."
        }
    }
}