const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const AbortController = require('abort-controller');
const fetch = require('node-fetch');
const ScenarioEngine = require('./scenarioEngine');
const PriceTransformer = require('./priceTransformer');

// ==========================================
// Reporter / Event Bus Setup
// ==========================================
const REPORTER_URL = `http://localhost:${process.env.REPORTER_PORT || 3001}/event`;

async function emitOrderEvent(type, payload) {
    try {
        await fetch(REPORTER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, ...payload }),
        }).catch(() => {});
    } catch(e) { /* intentional: fire-and-forget event emission */ }
}


// ==========================================
// 1. Core Configuration & State
// ==========================================

let globalUsers = {
    'user1': {
        label: 'User 1',
        listenKey: process.env.USER1_LISTEN_KEY || "",
        key: process.env.USER1_KEY || '45cda3aac77c85a66212c1eb1ed70df06defc46e8840aa6d',
        secret: process.env.USER1_SECRET || 'b3ebd30860c13a1bd1f44c358d746874ae52ca5396879de71366c5b2832596fd',
        email: 'mani.reddy+k0g0zvg8@coindcx.com',
        password: 'Test@123'
    },
    'user2': {
        label: 'User 2',
        listenKey: process.env.USER2_LISTEN_KEY || "",
        key: process.env.USER2_KEY || '6e3ef60d1fcfc8fb6c527eb8218bcdfaf56c02f422846367',
        secret: process.env.USER2_SECRET || 'ce547e76586bfe7d1fff793cb9373d04171b648f89de4706e7b9b2783715e72f',
        email: 'mani.reddy+n1d5l3gq@coindcx.com',
        password: 'Test@123'
    }
};

let globalRoles = {
    makerId: 'user1',
    takerId: 'user2'
};

let globalOrderUpdateCounter = 0;

let marketConfigs = [];

try {
    // The primary configuration method is now a JSON string from an environment variable.
    if (process.env.MARKET_CONFIGS) {
        console.log('Building configuration from MARKET_CONFIGS environment variable...');
        const parsedConfigs = JSON.parse(process.env.MARKET_CONFIGS);
        if (Array.isArray(parsedConfigs)) {
            marketConfigs = parsedConfigs;
            console.log(`Loaded ${marketConfigs.length} market configurations.`);
        } else {
            throw new Error('MARKET_CONFIGS is not a JSON array.');
        }
    } else {
        // Fallback for local development if the env var is not set.
        console.log('MARKET_CONFIGS env var not found. Falling back to local multi-config.json.');
        const configPath = path.resolve(__dirname, 'multi-config.json');
        marketConfigs = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    if (marketConfigs.length === 0) {
        throw new Error('No market configurations were loaded.');
    }
} catch (err) {
    console.error('FATAL: Failed to load market configurations.');
    console.error(err);
    process.exit(1);
}


// Global Verbose Debug Flag
const DEBUG = false;

// Global Portfolios (Account level)
let terminalLogs = [];
let maxTerminalLogs = 1000;
let lastPortfolioSyncTime = 0;
const PORTFOLIO_SYNC_INTERVAL_MS = 30000;

// Instrument Data Map (Dynamically loaded)
const instrumentsMap = {};
let sseClients = [];
let serverTimeOffset = 0;

// State file path for Jenkins userContent polling (set via env var)
const STATE_FILE_PATH = process.env.STATE_FILE_PATH || null;
function writeStateFile(payload) {
    if (!STATE_FILE_PATH) return;
    try {
        const tmp = STATE_FILE_PATH + '.tmp';
        fs.writeFileSync(tmp, payload, 'utf8');
        fs.renameSync(tmp, STATE_FILE_PATH);
    } catch (e) { /* ignore write errors — path may not exist yet */ }
}


const terminalEvents = [];

function pushLog(level, sym, msg, meta = null) {
    terminalLogs.push({ time: getISTTimeString(), level, sym, msg, ts: Date.now(), meta });
    if (terminalLogs.length > 200) terminalLogs.shift();
}

function pushEvent(level, sym, msg, meta = null, cat = 'general') {
    terminalEvents.push({ time: getISTTimeString(), level, sym, msg, ts: Date.now(), meta, cat });
    if (terminalEvents.length > 2000) terminalEvents.shift();
}

const log = {
    info:     (sym, msg, meta) => { console.log(`[\x1b[34mINFO\x1b[0m][${sym}] ${msg}`); pushLog('INFO', sym, msg, meta); },
    success:  (sym, msg, meta) => { console.log(`[\x1b[32mSUCCESS\x1b[0m][${sym}] ${msg}`); pushLog('SUCCESS', sym, msg, meta); },
    error:    (sym, msg, meta) => { console.error(`[\x1b[31mERROR\x1b[0m][${sym}] ${msg}`); pushLog('ERROR', sym, msg, meta); },
    warn:     (sym, msg, meta) => { console.log(`[\x1b[33mWARN\x1b[0m][${sym}] ${msg}`); pushLog('WARN', sym, msg, meta); },
    critical: (sym, msg, meta) => { console.log(`[\x1b[41m\x1b[37mCRITICAL\x1b[0m][${sym}] ${msg}`); pushLog('CRITICAL', sym, msg, meta); },
    debug:    (sym, msg, meta) => { if (DEBUG) { console.log(`[\x1b[35mDEBUG\x1b[0m][${sym}] ${msg}`); pushLog('DEBUG', sym, msg, meta); } }
};

function getISTTimeString() {
    const now = new Date();
    return now.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' IST';
}

// ==========================================
// 2. Cryptographic Engine & API Wrappers
// ==========================================
function signAndPrepare(url, method, payloadObj, userConfig) {
    const timestamp = Date.now() + serverTimeOffset;
    const isGetOrDelete = method.toUpperCase() === 'GET' || method.toUpperCase() === 'DELETE';

    const urlObj = new URL(url);
    let payloadStr = '';

    if (isGetOrDelete) {
        urlObj.searchParams.set('timestamp', String(timestamp));
        urlObj.searchParams.set('recvWindow', '60000');
        if (payloadObj) {
            Object.keys(payloadObj).forEach(k => urlObj.searchParams.set(k, String(payloadObj[k])));
        }
        payloadStr = '';
    } else {
        const bodyObj = { ...payloadObj, timestamp, recvWindow: 60000 };
        payloadStr = JSON.stringify(bodyObj);
    }

    const signature = crypto
        .createHmac('sha256', userConfig.secret)
        .update(payloadStr)
        .digest('hex');

    const headers = {
        'Content-Type': 'application/json',
        'X-AUTH-APIKEY': userConfig.key,
        'X-AUTH-SIGNATURE': signature
    };
    
    // Cookie is no longer in config, so this is effectively disabled but kept for structure.
    // if (config.testnet.cookie) headers['Cookie'] = config.testnet.cookie;

    return { finalUrl: urlObj.toString(), payloadStr: isGetOrDelete ? null : payloadStr, headers };
}

async function sendSignedRequest(url, method, payload, userConfig, timeoutMs = 50000) {
    const { finalUrl, payloadStr, headers } = signAndPrepare(url, method, payload, userConfig);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const startTime = Date.now();
    const uLabel = userConfig ? (userConfig.label || 'User') : 'System';

    try {
        const options = { method: method.toUpperCase(), headers, body: payloadStr || undefined, signal: controller.signal };
        const res = await fetch(finalUrl, options);
        clearTimeout(timeoutId);

        const latencyMs = Date.now() - startTime;
        const text = await res.text();
        
        let data;
        try { data = JSON.parse(text); }
        catch (e) { data = { error: text || 'Invalid JSON response from server' }; }

        const shortUrl = new URL(finalUrl).pathname;
        const meta = {
            request: { method: method.toUpperCase(), url: shortUrl, payload: payload },
            response: { status: res.status, data: data }
        };
        log.info(uLabel, `[${method.toUpperCase()}] ${shortUrl} | Status: ${res.status} | Latency: ${latencyMs}ms`, meta);

        if (!res.ok || DEBUG) log.debug('REST-API', `[${method.toUpperCase()}] ${finalUrl} | Status: ${res.status} | Body: ${text} | Latency: ${latencyMs}ms`);

        return { ok: res.ok, status: res.status, data, latencyMs };
    } catch (err) {
        clearTimeout(timeoutId);
        const latencyMs = Date.now() - startTime;
        const isTimeout = err.name === 'AbortError' || err.message.includes('aborted');
        const shortUrl = new URL(finalUrl).pathname;
        if (isTimeout) log.error(uLabel, `[TIMEOUT] ${method.toUpperCase()} to ${shortUrl} timed out after ${latencyMs}ms.`);
        else log.error(uLabel, `[ERROR] ${method.toUpperCase()} to ${shortUrl} failed after ${latencyMs}ms: ${err.message}`);
        return { ok: false, status: isTimeout ? 408 : 500, error: isTimeout ? 'Request Timeout' : err.message, latencyMs };
    }
}

// Seed balance helper — logs in with email/password to get bearer token, then calls seed_balance
async function seedBalance(userCreds) {
    const AUTH_URL = 'https://testnet-api.dcxstage.com/api/v3/authenticate';
    const SEED_URL = 'https://testnet-futures-hpo.dcxstage.com/api/v1/derivatives/futures/wallets/seed_balance';
    try {
        emitOrderEvent('seed:triggered', { user: userCreds.email });
        if (!userCreds.email || !userCreds.password) {
            log.warn('SYSTEM', '[SEED] No email/password configured for this user — cannot seed balance.');
            emitOrderEvent('seed:failed', { user: userCreds.email, error: 'No email/password configured' });
            return false;
        }

        // Step 1: Login to get bearer token
        log.info('SYSTEM', '[SEED] Authenticating ' + userCreds.email + ' to get bearer token...');
        const loginRes = await fetch(AUTH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'PostmanRuntime/7.32.3' },
            body: JSON.stringify({ email: userCreds.email, password: userCreds.password, pe: false, piie: false })
        });
        const loginData = await loginRes.json();
        const bearerToken = loginData.auth_token || loginData.token;

        if (!bearerToken) {
            log.warn('SYSTEM', '[SEED] Login failed — no auth_token in response: ' + JSON.stringify(loginData));
            emitOrderEvent('seed:failed', { user: userCreds.email, error: 'Login failed: ' + JSON.stringify(loginData) });
            return false;
        }
        log.success('SYSTEM', '[SEED] Login successful. Got bearer token.');

        // Step 2: Call seed_balance with bearer token
        log.info('SYSTEM', '[SEED] Calling seed_balance...');
        const seedRes = await fetch(SEED_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': bearerToken,
                'User-Agent': 'PostmanRuntime/7.32.3'
            },
            body: JSON.stringify({ currency_short_name: 'USDT' })
        });
        const seedData = await seedRes.json().catch(function() { return {}; });

        if (seedRes.ok || seedRes.status < 400) {
            log.success('SYSTEM', '[SEED] seed_balance succeeded — wallet topped up.');
            emitOrderEvent('seed:success', { user: userCreds.email });
            return true;
        }
        log.warn('SYSTEM', '[SEED] seed_balance returned non-OK [' + seedRes.status + ']: ' + JSON.stringify(seedData));
        emitOrderEvent('seed:failed', { user: userCreds.email, error: JSON.stringify(seedData) });
        return false;
    } catch (err) {
        log.error('SYSTEM', '[SEED] seed_balance threw: ' + err.message);
        emitOrderEvent('seed:failed', { user: userCreds.email, error: err.message });
        return false;
    }
}

async function syncServerTime() {
    const urls = [
        `https://fapi.binance.com/fapi/v1/time`,
        `https://api.binance.com/api/v3/time`,
        `https://testnet-futures-hpo.dcxstage.com/fapi/v1/time`
    ];
    for (const url of urls) {
        try {
            const res = await fetch(url);
            if (res.ok) {
                const data = await res.json();
                const serverTime = data.serverTime || data.time;
                if (serverTime) {
                    serverTimeOffset = serverTime - Date.now();
                    log.success('SYSTEM', `Time synced via ${new URL(url).hostname}. Offset: ${serverTimeOffset}ms`);
                    return;
                }
            }
        } catch (e) { log.debug && log.debug('SYSTEM', e.message); }
    }
    log.warn('SYSTEM', `Time sync failed across all endpoints. Using local system clock.`);
}

async function loadInstruments() {
    try {
        log.info('SYSTEM', 'Fetching Instrument parameters and Exchange Info...');
        
        // Fetch custom futures data
        const resData = await fetch(`https://testnet-futures-hpo.dcxstage.com/api/v1/derivatives/futures/data`, {
            headers: { 'X-app-version': '6.56.0002' }
        });
        const data = await resData.json();

        if (data && data.instruments) {
            data.instruments.forEach(inst => {
                const tick = parseFloat(inst.tick_size || inst.price_increment || 0.0001);
                const step = parseFloat(inst.quantity_increment || inst.min_trade_size || 1.0);
                const pricePrecision = (tick > 0 && isFinite(tick)) ? Math.max(0, -Math.round(Math.log10(tick))) : 4;
                const qtyPrecision   = (step > 0 && isFinite(step)) ? Math.max(0, -Math.round(Math.log10(step))) : 0;

                instrumentsMap[inst.symbol.toUpperCase()] = {
                    tickSize: tick > 0 ? tick : 0.0001,
                    qtyStep:  step > 0 ? step : 1.0,
                    minQty:   parseFloat(inst.min_quantity || inst.min_trade_size || step || 1.0),
                    pricePrecision,
                    qtyPrecision,
                    multiplierUp: 5,   // Default
                    multiplierDown: 5  // Default
                };
            });
        }

        // Fetch official FAPI exchangeInfo to get exact limits (PERCENT_PRICE and LOT_SIZE)
        const resInfo = await fetch(`https://testnet-futures-hpo.dcxstage.com/fapi/v1/exchangeInfo`);
        const info = await resInfo.json();
        
        if (info && info.symbols) {
            info.symbols.forEach(sym => {
                const symbol = sym.symbol.toUpperCase();
                if (instrumentsMap[symbol]) {
                    // Extract LOT_SIZE minQty
                    const lotSize = sym.filters.find(f => f.filterType === 'LOT_SIZE');
                    if (lotSize && lotSize.minQty) {
                        instrumentsMap[symbol].minQty = parseFloat(lotSize.minQty);
                        instrumentsMap[symbol].qtyStep = parseFloat(lotSize.stepSize);
                    }
                    // Extract PERCENT_PRICE multipliers
                    const pctPrice = sym.filters.find(f => f.filterType === 'PERCENT_PRICE');
                    if (pctPrice) {
                        instrumentsMap[symbol].multiplierUp = parseFloat(pctPrice.multiplierUp);
                        instrumentsMap[symbol].multiplierDown = parseFloat(pctPrice.multiplierDown);
                    }
                }
            });
        }
        
        log.success('SYSTEM', `Loaded ${Object.keys(instrumentsMap).length} instruments with limit multipliers.`);
    } catch (e) { log.error('SYSTEM', `Instrument fetch failed: ${e.message}`); }
}

function calculateQty(sizeUsdt, priceStr, symbol) {
    const price = parseFloat(priceStr);
    const inst = instrumentsMap[symbol] || { qtyStep: 1.0, minQty: 1.0, qtyPrecision: 0 };

    if (isNaN(price) || price <= 0) return inst.minQty.toFixed(inst.qtyPrecision);

    let rawQty = sizeUsdt / price;
    const factor = 1 / inst.qtyStep;
    let qty = Math.round(rawQty * factor) / factor;
    if (qty < inst.minQty) qty = inst.minQty;

    return qty.toFixed(inst.qtyPrecision);
}

function formatRawQty(rawQty, symbol) {
    const inst = instrumentsMap[symbol] || { qtyStep: 1.0, minQty: 1.0, qtyPrecision: 0 };
    const factor = 1 / inst.qtyStep;
    let qty = Math.round(rawQty * factor) / factor;
    return qty.toFixed(inst.qtyPrecision);
}

function formatPrice(priceStr, symbol) {
    const inst = instrumentsMap[symbol] || { pricePrecision: 4 };
    return parseFloat(priceStr).toFixed(inst.pricePrecision);
}

function applyBuffer(priceStr, side, bufferPct, symbol) {
    if (!bufferPct || bufferPct === 0) return formatPrice(priceStr, symbol);
    const raw = parseFloat(priceStr);
    const multiplier = side.toUpperCase() === 'BUY'
        ? (1 - bufferPct / 100)
        : (1 + bufferPct / 100);
    return formatPrice(String(raw * multiplier), symbol);
}

// Global user data stream WebSocket clients (persists across instance restarts)
const globalUserWsClients = {};

async function fetchListenKeys() {
    log.info('SYSTEM', 'Checking listen keys for user data streams...');
    for (const [userId, userConfig] of Object.entries(globalUsers)) {
        // If listen key already set (from env or config), connect directly
        if (userConfig.listenKey) {
            log.success('SYSTEM', `Listen key pre-configured for ${userConfig.label || userId} — connecting...`);
            if (!globalUserWsClients[userId]) {
                globalUserWsClients[userId] = new PrivateWsClient(
                    userConfig.listenKey,
                    () => {},
                    userConfig.label || userId
                );
            }
            continue;
        }
        
        if (!userConfig.key || !userConfig.secret) continue;

        // Try to fetch listen key from API (may not exist on all platforms)
        try {
            const res = await sendSignedRequest(
                `https://testnet-futures-hpo.dcxstage.com/fapi/v1/listenKey`,
                'POST', null, userConfig
            );
            if (res.ok && res.data && res.data.listenKey) {
                userConfig.listenKey = res.data.listenKey;
                log.success('SYSTEM', `Listen key obtained for ${userConfig.label || userId}`);
                globalUserWsClients[userId] = new PrivateWsClient(
                    userConfig.listenKey,
                    () => {},
                    userConfig.label || userId
                );
            } else {
                log.info('SYSTEM', `Listen key API not available for ${userConfig.label || userId} — private WS events will use instance connections.`);
            }
        } catch (e) {
            log.info('SYSTEM', `Listen key not available for ${userConfig.label || userId} — skipping.`);
        }
    }
}

// Keepalive: PUT to refresh listen keys every 30 minutes
function startListenKeyKeepalive() {
    setInterval(async () => {
        for (const [userId, userConfig] of Object.entries(globalUsers)) {
            if (!userConfig.listenKey) continue;
            try {
                await sendSignedRequest(
                    `https://testnet-futures-hpo.dcxstage.com/fapi/v1/listenKey`,
                    'PUT', { listenKey: userConfig.listenKey }, userConfig
                );
            } catch (e) { /* silently ignore if not supported */ }
        }
    }, 30 * 60 * 1000);
}

// ==========================================
// 3. Replicator Engine Instance
// ==========================================
class PrivateWsClient {
    constructor(listenKey, onMessageCb, label) {
        this.listenKey = listenKey;
        this.onMessageCb = onMessageCb;
        this.label = label;
        this.ws = null;
        this.pingInterval = null;
        this.reconnectTimer = null;
        if (this.listenKey) this.connect();
    }
    
    connect() {
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        if (this.ws) this.ws.close();
        // Subscribe to ALL user data events (no events= filter)
        const url = `wss://testnet-futures-socket-gateway.dcxstage.com/private/ws?listenKey=${this.listenKey}`;
        log.info('SYSTEM', `Connecting ${this.label} User Data Stream (all events)...`);
        this.ws = new WebSocket(url);
        
        this.ws.on('open', () => {
            log.success('SYSTEM', `${this.label} User Data Stream connected (all events).`);
            pushEvent('SUCCESS', this.label, `User Data Stream connected`, { status: 'connected', events: 'ALL' }, 'ws');
            this.pingInterval = setInterval(() => {
                if (this.ws.readyState === WebSocket.OPEN) this.ws.ping();
            }, 30000);
        });
        
        this.ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                const eventType = msg.e || 'Unknown';

                // Push descriptive events based on type
                if (eventType === 'ORDER_TRADE_UPDATE') {
                    const o = msg.o || {};
                    const summary = `${o.S || ''} ${o.o || ''} ${o.s || ''} | Qty: ${o.q || '-'} | Price: ${o.p || '-'} | Status: ${o.X || '-'}`;
                    pushEvent('EVENT', this.label, `Order Update: ${summary}`, msg, 'order');
                    globalOrderUpdateCounter++;
                    this.onMessageCb(o);
                } else if (eventType === 'ACCOUNT_UPDATE') {
                    const a = msg.a || {};
                    const reason = a.m || 'unknown';
                    const balances = (a.B || []).map(b => `${b.a}: ${b.wb}`).join(', ') || 'N/A';
                    const positions = (a.P || []).length;
                    pushEvent('EVENT', this.label, `Account Update [${reason}] | Balances: ${balances} | Positions changed: ${positions}`, msg, 'account');
                } else if (eventType === 'BALANCE_UPDATE') {
                    const delta = msg.d || '0';
                    pushEvent('EVENT', this.label, `Balance Update | Delta: ${delta}`, msg, 'balance');
                } else if (eventType === 'listenKeyExpired') {
                    pushEvent('WARN', this.label, `Listen key expired — reconnecting...`, msg, 'ws');
                    this.ws.close();
                } else {
                    pushEvent('EVENT', this.label, `WS Event: ${eventType}`, msg, 'general');
                }
            } catch (e) {
                log.error('SYSTEM', `Error parsing ${this.label} WS: ${e.message}`);
            }
        });
        
        this.ws.on('close', () => {
            log.warn('SYSTEM', `${this.label} User Data Stream disconnected. Reconnecting in 3s...`);
            pushEvent('WARN', this.label, `User Data Stream disconnected`, { status: 'disconnected' }, 'ws');
            clearInterval(this.pingInterval);
            this.reconnectTimer = setTimeout(() => this.connect(), 3000);
        });
        
        this.ws.on('error', (err) => {
            log.error('SYSTEM', `${this.label} User Data Stream error: ${err.message}`);
            pushEvent('ERROR', this.label, `User Data Stream error: ${err.message}`, { error: err.message }, 'ws');
        });
    }
}

class ReplicatorInstance {
    constructor(marketConfig) {
        this.sourceSymbol = marketConfig.sourceSymbol.toUpperCase();
        this.targetSymbol = (marketConfig.targetSymbol || marketConfig.sourceSymbol).toUpperCase();
        
        this.symbol = this.targetSymbol; 
        this.status = 'STOPPED';

        this.minSize            = marketConfig.minSize            || 100;
        this.maxSize            = marketConfig.maxSize            || 500;
        this.depthLevels        = marketConfig.depthLevels        || 10;
        this.qtyChangeTolerance = marketConfig.qtyChangeTolerance || 0.25;
        this.enableTradeSync    = marketConfig.enableTradeSync !== false;
        this.newUserFlow        = marketConfig.newUserFlow === true;
        this.bufferPct          = marketConfig.bufferPct          || 0;
        this.cancelOnStop       = marketConfig.cancelOnStop !== false;
        this.tradeDelayMs       = marketConfig.tradeDelayMs       || 0;
        
        this.inFlightEdits      = new Set();

        this.binanceDepth  = { bids: [], asks: [] };
        this.testnetDepth  = { bids: [], asks: [] };
        this.restingBids   = [];    
        this.restingAsks   = [];
        this.syncedTrades  = [];

        this.tradeQueue          = [];
        this.priceLocks          = new Set();
        this.ghostCancelQueue    = new Set();
        this.inFlightCancels     = new Set();
        this.cancelRetries       = new Map();
        this.inFlightTakerOrders = new Map();

        this.isCrossing         = false;
        this.isSyncingDelta     = false;
        this.isCancellingGhosts = false;
        this.isAligningLtp      = false;
        this.isSyncingGrid      = false;

        this.wsBinanceDepth  = null;
        this.wsBinanceTrades = null;
        this.wsTestnet       = null;
        this.wsTestnetTicker = null;
        this.testnetPingInterval = null;

        this.testnetLatency    = 0;
        this.binanceLatency    = 0;
        this.binanceLtp        = "0.0000";
        this.totalSyncAttempts = 0;
        this.successfulSyncs   = 0;
        this.hasLoggedAuthError = false;

        // H6: TTL cleanup for stale inFlightTakerOrders entries (30s expiry, checked every 15s)
        setInterval(() => {
            const now = Date.now();
            for (const [id, entry] of this.inFlightTakerOrders.entries()) {
                if (now - entry.ts > 30000) this.inFlightTakerOrders.delete(id);
            }
        }, 15000);

        this.makerWs = new PrivateWsClient(globalUsers[globalRoles.makerId].listenKey, this.onMakerWsEvent.bind(this), 'Maker');
        this.takerWs = new PrivateWsClient(globalUsers[globalRoles.takerId].listenKey, this.onTakerWsEvent.bind(this), 'Taker');
    }

    onMakerWsEvent(o) {
        if (o.s !== this.symbol) return;
        const status = o.X || o.x;
        
        // Find existing order
        const pool = o.S === 'BUY' ? this.restingBids : this.restingAsks;
        const existingIdx = pool.findIndex(r => String(r.orderId) === String(o.i));

        if (status === 'NEW' && existingIdx === -1) {
            const ro = {
                orderId: o.i,
                price: o.p,
                qty: o.q,
                executedQty: o.z,
                side: o.S,
                status: status,
                createdAt: Date.now()
            };
            pool.push(ro);
        } else if (['CANCELED', 'FILLED', 'EXPIRED', 'REJECTED'].includes(status)) {
            if (o.S === 'BUY') this.restingBids = this.restingBids.filter(r => String(r.orderId) !== String(o.i));
            else this.restingAsks = this.restingAsks.filter(r => String(r.orderId) !== String(o.i));
        } else if (existingIdx !== -1) {
            // Update PARTIALLY_FILLED or other states
            pool[existingIdx].status = status;
            pool[existingIdx].executedQty = o.z;
        }
    }

    onTakerWsEvent(o) {
        if (o.s !== this.symbol) return;
        const status = o.X || o.x;
        // PARTIALLY_FILLED is an intermediate state for IOC orders; wait for EXPIRED or FILLED.
        const isTerminal = ['CANCELED', 'FILLED', 'EXPIRED', 'REJECTED'].includes(status);
        
        if (isTerminal && o.c && this.inFlightTakerOrders.has(o.c)) {
            const context = this.inFlightTakerOrders.get(o.c);
            
            let finalStatus = status;
            const executedQty = parseFloat(o.z || '0');
            
            // For IOC orders: if EXPIRED but with fills, it's PARTIALLY_FILLED. If 0 fills, it's FAILED.
            if (status === 'EXPIRED') {
                if (executedQty === 0) finalStatus = 'FAILED';
                else finalStatus = 'PARTIALLY_FILLED';
            }
            
            this.syncedTrades.unshift({
                id: crypto.randomUUID(),
                time: getISTTimeString(),
                price: context.limitPrice,
                avgPrice: o.ap && parseFloat(o.ap) > 0 ? String(o.ap) : null,
                side: o.S,
                binanceQty: context.binanceQty,
                stageQty: executedQty > 0 ? String(o.z) : context.expectedQty,
                success: (finalStatus === 'FILLED' || finalStatus === 'PARTIALLY_FILLED'),
                status: finalStatus,
                makerOrderId: context.makerOrderId,
                takerOrderId: o.i
            });
            if (this.syncedTrades.length > 5000) this.syncedTrades.pop();
            this.inFlightTakerOrders.delete(o.c);
            
            if (finalStatus === 'FAILED' || finalStatus === 'CANCELED') {
                log.error(this.symbol, `[EXECUTION] Trade sync failed: ${finalStatus} (Stage Qty: ${executedQty})`);
                emitOrderEvent('order:fill_failed', {
                    symbol: this.symbol,
                    makerOrderId: context.makerOrderId,
                    takerOrderId: o.i,
                    error: { msg: `Taker execution terminal state: ${finalStatus}` }
                });
            } else {
                log.success(this.symbol, `[EXECUTION] Trade synced! Filled ${executedQty} @ ${o.ap || context.limitPrice}`);
                emitOrderEvent('order:fill_success', {
                    symbol: this.symbol,
                    makerOrderId: context.makerOrderId,
                    takerOrderId: o.i,
                    status: finalStatus
                });
            }
        }
    }

    async placeOrder(side, qty, price = null, orderType = 'LIMIT', isTaker = false, clientOrderId = null, _isRetry = false) {
        const userCreds = isTaker ? globalUsers[globalRoles.takerId] : globalUsers[globalRoles.makerId];
        const userLabel = isTaker ? 'USER2_TAKER' : 'USER1_MAKER';
        const bufferedPrice = price ? applyBuffer(String(price), side, this.bufferPct, this.symbol) : null;

        const payload = { symbol: this.symbol, side: side.toUpperCase(), quantity: String(qty) };
        if (clientOrderId) payload.newClientOrderId = clientOrderId;
        if (orderType === 'LIMIT') {
            payload.type = 'LIMIT';
            payload.price = String(bufferedPrice);
            payload.timeInForce = 'GTC';
        } else if (orderType === 'LIMIT_IOC') {
            payload.type = 'LIMIT';
            payload.price = String(bufferedPrice);
            payload.timeInForce = 'IOC';
        } else if (orderType === 'MARKET') {
            payload.type = 'MARKET';
        }

        log.debug(this.symbol, `[ORDER-PRE] ${userLabel} placing ${orderType} ${side} ${qty} @ ${bufferedPrice || 'MKT'} (raw: ${price}, buf: ${this.bufferPct}%)`);
        const res = await sendSignedRequest(`https://testnet-futures-hpo.dcxstage.com/fapi/v1/order`, 'POST', payload, userCreds);

        if (res.status === 401) { this.handleAuthFailure(userLabel); return { success: false }; }

        // Auto-retry on limit multiplier constraint: pause, align LTP, retry
        if (!res.ok && !_isRetry && res.data) {
            const msgStr = JSON.stringify(res.data).toLowerCase();
            const isLimitErr = res.data.code === -1013 || res.data.code === -2011 || res.data.code === -4003 || res.data.code === -4024 ||
                               msgStr.includes('percent_price') || msgStr.includes('price less than') || 
                               msgStr.includes('price greater than') || msgStr.includes('limit') ||
                               msgStr.includes('higher than') || msgStr.includes('lower than');
                               
            if (isLimitErr) {
                log.warn(this.symbol, `[ALIGN] ${userLabel} hit price limit (${res.data.code}). Triggering LTP alignment...`);
                if (!this.isAligningLtp) {
                    const currentBinanceLtp = this.binanceDepth.bids.length ? this.binanceDepth.bids[0][0] : null;
                    if (currentBinanceLtp) this.alignLtpToTarget(parseFloat(currentBinanceLtp), side, res.data.msg).catch(e => log.error(this.symbol, `[ALIGN] Background alignment failed: ${e.message}`));
                }
            }
            
            // Handle Max Position Limit Error (-2010)
            if (res.data.code === -2010) {
                log.warn(this.symbol, `[POSITION-LIMIT] ${userLabel} hit max position (-2010). Invoking 50% reduction...`);
                await this.reducePositions();
                log.success(this.symbol, `[POSITION-LIMIT] Reduction process finished. Retrying original order...`);
                return this.placeOrder(side, qty, price, orderType, isTaker, clientOrderId, true);
            }
        }

        // Auto-retry on insufficient funds: call seed_balance then retry once
        if (!res.ok && !_isRetry && res.data && res.data.code === -2018) {
            log.warn(this.symbol, `[SEED] ${userLabel} insufficient funds — calling seed_balance and retrying...`);
            const seeded = await seedBalance(userCreds);
            if (seeded) {
                log.success(this.symbol, `[SEED] ${userLabel} balance topped up. Retrying order...`);
                return this.placeOrder(side, qty, price, orderType, isTaker, clientOrderId, true);
            } else {
                log.error(this.symbol, `[SEED] ${userLabel} seed_balance failed — cannot retry.`);
            }
        }

        if (res.ok) {
            log.debug(this.symbol, `[ORDER-POST] ${userLabel} placed OK. ID: ${res.data.orderId || res.data.id}`);
            emitOrderEvent('order:placed', {
                symbol: this.symbol,
                side,
                qty,
                price: bufferedPrice,
                orderId: res.data.orderId || res.data.id,
                isTaker,
                orderType,
                latencyMs: res.latencyMs
            });
            return { 
                success: true, 
                orderId: String(res.data.orderId || res.data.id), 
                price: bufferedPrice,
                avgPrice: res.data.avgPrice,
                executedQty: res.data.executedQty,
                status: res.data.status,
                side: side.toUpperCase()
            };
        }
        log.error(this.symbol, `[ORDER-FAIL] ${userLabel} failed: ${JSON.stringify(res.data || res.error)}`);
        emitOrderEvent('order:place_failed', {
            symbol: this.symbol,
            side,
            qty,
            price: bufferedPrice,
            isTaker,
            orderType,
            latencyMs: res.latencyMs,
            error: res.data || { msg: res.error }
        });
        return { success: false, error: res.data || { msg: res.error } };
    }

    async modifyMaker(orderId, side, rawPrice, qty) {
        if (!orderId) return false;
        const bufferedPrice = applyBuffer(String(rawPrice), side, this.bufferPct, this.symbol);

        const payload = {
            symbol:   this.symbol,
            orderId,
            side:     side.toUpperCase(),
            quantity: String(qty),
            price:    String(bufferedPrice)
        };

        log.debug(this.symbol, `[MODIFY-PRE] USER1_MAKER modifying ID: ${orderId} -> ${qty} @ ${bufferedPrice} (raw: ${rawPrice}, buf: ${this.bufferPct}%)`);
        const res = await sendSignedRequest(`https://testnet-futures-hpo.dcxstage.com/fapi/v1/order`, 'PUT', payload, globalUsers[globalRoles.makerId]);

        if (res.status === 401) this.handleAuthFailure('USER1_MAKER');
        const isTerminal = res.ok || res.status === 404 || (res.data && [-2011, -2013, -4000].includes(res.data.code));
        
        if (res.ok) {
            log.debug(this.symbol, `[MODIFY-POST] Modified OK. ID: ${orderId}`);
            emitOrderEvent('order:modified', {
                symbol: this.symbol,
                orderId,
                side,
                newPrice: bufferedPrice,
                newQty: qty,
                latencyMs: res.latencyMs
            });
        } else {
            if (isTerminal) {
                log.debug(this.symbol, `[MODIFY-TERMINAL] ID: ${orderId} terminal (${res.data?.code}). Handled automatically.`);
            } else {
                log.error(this.symbol, `[MODIFY-FAIL] ID: ${orderId} failed: ${JSON.stringify(res.data || res.error)}`);
            }
            emitOrderEvent('order:modify_failed', {
                symbol: this.symbol,
                orderId,
                side,
                newPrice: bufferedPrice,
                newQty: qty,
                latencyMs: res.latencyMs,
                error: res.data || { msg: res.error }
            });
        }
        return { success: res.ok, isTerminal };
    }
    async alignLtpToTarget(targetPrice, failedSide = null, errMsg = null) {
        if (this.isAligningLtp) return;
        this.isAligningLtp = true;
        try {
            const inst = instrumentsMap[this.symbol];
            if (!inst || !inst.multiplierUp || !inst.multiplierDown) return;

            log.info(this.symbol, `[ALIGN] Checking if Testnet LTP needs alignment to ${targetPrice}...`);
            
            // 1. Determine exact testnet LTP from the error message limits
            let testnetLtp = null;
            if (errMsg) {
                const match = errMsg.toLowerCase().match(/higher than ([\d.]+)/) || errMsg.toLowerCase().match(/lower than ([\d.]+)/);
                if (match) {
                    const boundPrice = parseFloat(match[1]);
                    // If SELL failed with "higher than", boundPrice = LTP * (1 - multiplierDown)
                    if (errMsg.toLowerCase().includes('higher than')) {
                        testnetLtp = boundPrice / (1 - inst.multiplierDown / 100);
                    } 
                    // If BUY failed with "lower than", boundPrice = LTP * (1 + multiplierUp)
                    else if (errMsg.toLowerCase().includes('lower than')) {
                        testnetLtp = boundPrice / (1 + inst.multiplierUp / 100);
                    }
                }
            }
            
            // Fallback to local book depth if regex failed or no errMsg
            if (!testnetLtp) {
                if (this.testnetDepth && this.testnetDepth.bids && this.testnetDepth.bids.length > 0) {
                    testnetLtp = parseFloat(this.testnetDepth.bids[0][0]);
                } else if (this.testnetDepth && this.testnetDepth.asks && this.testnetDepth.asks.length > 0) {
                    testnetLtp = parseFloat(this.testnetDepth.asks[0][0]);
                }
            }
            
            if (!testnetLtp) {
                log.warn(this.symbol, `[ALIGN] Testnet book is completely empty and no strict bounds found. Will assume targetPrice as LTP.`);
                testnetLtp = targetPrice;
            }

            // Round the mathematically derived LTP to a sensible precision
            testnetLtp = parseFloat(testnetLtp.toFixed(inst.pricePrecision + 1));

            // 2. Check if within safe bounds (using 90% of allowed multiplier to be safe)
            const safeUpPct = (inst.multiplierUp / 100) * 0.90;
            const safeDownPct = (inst.multiplierDown / 100) * 0.90;

            const upperBound = testnetLtp * (1 + safeUpPct);
            const lowerBound = testnetLtp * (1 - safeDownPct);

            if (targetPrice <= upperBound && targetPrice >= lowerBound) {
                log.info(this.symbol, `[ALIGN] LTP (${testnetLtp}) is within limits of target (${targetPrice}). No alignment needed.`);
                return;
            }

            log.warn(this.symbol, `[ALIGN] LTP (${testnetLtp}) is too far from Target (${targetPrice}). Limits: [${lowerBound.toFixed(inst.pricePrecision)}, ${upperBound.toFixed(inst.pricePrecision)}].`);

            const minQtyStr = calculateQty(0, '1', this.symbol); // Gets minimum formatted qty

            // 3. Attempt Instant Market Alignment
            // Since syncGrid places one side of the book successfully before the other side fails,
            // the successful side is already resting on the book. We can instantly drag the LTP by placing a MARKET order against it.
            let marketRes = { success: false };
            const dragSide = failedSide || (targetPrice > testnetLtp ? 'BUY' : 'SELL');
            
            log.info(this.symbol, `[ALIGN] Firing TAKER MARKET ${dragSide} to hit resting limits and drag LTP...`);
            marketRes = await this.placeOrder(dragSide, minQtyStr, null, 'MARKET', true, true);

            if (marketRes.success) {
                log.success(this.symbol, `[ALIGN] Successfully dragged LTP instantly via MARKET order.`);
                return;
            }

            log.warn(this.symbol, `[ALIGN] Instant MARKET drag failed or not fully aligned. Falling back to slow Price Ladder...`);

            // 4. Price ladder fallback loop (if book was empty)
            let steps = 0;
            while (steps < 50) { // Max 50 steps to prevent infinite loop
                steps++;
                
                let nextPrice = targetPrice;
                if (targetPrice > testnetLtp) {
                    nextPrice = testnetLtp * (1 + safeUpPct);
                    if (nextPrice >= targetPrice) nextPrice = targetPrice;
                } else if (targetPrice < testnetLtp) {
                    nextPrice = testnetLtp * (1 - safeDownPct);
                    if (nextPrice <= targetPrice) nextPrice = targetPrice;
                }

                let priceStr = formatPrice(String(nextPrice), this.symbol);
                log.info(this.symbol, `[ALIGN] Step ${steps}: Moving LTP from ${testnetLtp} to ${priceStr}`);

                // Place Maker - if targetPrice > testnetLtp, place BUY maker and hit with SELL taker.
                // If targetPrice < testnetLtp, place SELL maker and hit with BUY taker.
                const makerSide = targetPrice > testnetLtp ? 'BUY' : 'SELL';
                const takerSide = targetPrice > testnetLtp ? 'SELL' : 'BUY';

                let makerRes = await this.placeOrder(makerSide, minQtyStr, priceStr, 'LIMIT', false, true); // _isRetry=true
                
                // If it failed because of strict limit constraints, try to extract the exact bound from the error
                if (!makerRes.success && makerRes.error && makerRes.error.msg) {
                    const errMsg = makerRes.error.msg.toLowerCase();
                    const match = errMsg.match(/higher than ([\d.]+)/) || errMsg.match(/lower than ([\d.]+)/);
                    if (match) {
                        const boundPrice = parseFloat(match[1]);
                        log.warn(this.symbol, `[ALIGN] Extracted strict engine bound from error: ${boundPrice}. Adjusting nextPrice...`);
                        
                        // Give it a tiny safe margin into the valid side
                        if (errMsg.includes('higher than')) {
                            nextPrice = boundPrice * 1.0005; // 0.05% higher than the strict minimum bound
                        } else {
                            nextPrice = boundPrice * 0.9995; // 0.05% lower than the strict maximum bound
                        }
                        
                        if ((targetPrice > testnetLtp && nextPrice >= targetPrice) || (targetPrice < testnetLtp && nextPrice <= targetPrice)) {
                            nextPrice = targetPrice;
                        }
                        
                        priceStr = formatPrice(String(nextPrice), this.symbol);
                        log.info(this.symbol, `[ALIGN] Retrying Maker with adjusted safe price: ${priceStr}`);
                        makerRes = await this.placeOrder(makerSide, minQtyStr, priceStr, 'LIMIT', false, true);
                    }
                }

                if (!makerRes.success) {
                    log.error(this.symbol, `[ALIGN] Failed to place Maker at ${priceStr}. Aborting alignment.`);
                    break;
                }

                // Place Taker IOC to cross it
                await this.placeOrder(takerSide, minQtyStr, priceStr, 'LIMIT_IOC', true, true);
                
                // Cleanup maker just in case it didn't fill
                await this.cancelOrder(makerRes.orderId);

                testnetLtp = nextPrice;
                if (Math.abs(testnetLtp - targetPrice) < 0.000001) {
                    log.success(this.symbol, `[ALIGN] Successfully dragged LTP to target ${targetPrice}`);
                    break;
                }
                
                await new Promise(r => setTimeout(r, 200));
            }
        } catch (e) {
            log.error(this.symbol, `[ALIGN] Exception during LTP alignment: ${e.message}`);
        } finally {
            this.isAligningLtp = false;
        }
    }

    async reducePositions() {
        if (this.isReducingPositions) return;
        this.isReducingPositions = true;
        log.warn(this.symbol, `[POSITION-LIMIT] Initiating 50% position reduction for both Maker and Taker...`);

        try {
            // Cancel all open orders first to free up max position quota
            log.info(this.symbol, `[REDUCE-POS] Wiping existing open orders before reducing...`);
            await this.wipeOrders();

            // Pick a cross price (current testnet LTP or binance LTP)
            const fallbackPrice = this.testnetDepth.bids.length ? this.testnetDepth.bids[0][0] : (this.binanceDepth.bids.length ? this.binanceDepth.bids[0][0] : null);
            if (!fallbackPrice) {
                log.error(this.symbol, `[REDUCE-POS] Cannot determine cross price. Aborting.`);
                return;
            }
            const crossPriceStr = formatPrice(String(fallbackPrice), this.symbol);

            const reduceUser = async (userCreds, userLabel) => {
                const posRes = await sendSignedRequest(`https://testnet-futures-hpo.dcxstage.com/fapi/v2/positionRisk?symbol=${this.symbol}`, 'GET', null, userCreds);
                if (!posRes.ok || !posRes.data) return false;

                const positions = Array.isArray(posRes.data) ? posRes.data : [posRes.data];
                const targetPos = positions.find(p => p.symbol === this.symbol);
                if (!targetPos) return false;

                const amt = parseFloat(targetPos.positionAmt);
                if (amt === 0) return true;

                const reduceQtyStr = formatRawQty(Math.abs(amt) * 0.5, this.symbol);
                if (parseFloat(reduceQtyStr) === 0) return true;

                const side = amt > 0 ? 'SELL' : 'BUY';
                
                log.info(this.symbol, `[REDUCE-POS] ${userLabel} has ${amt} open position. Placing ${side} LIMIT @ ${crossPriceStr} for ${reduceQtyStr} to reduce by 50%...`);
                
                const payload = {
                    symbol: this.symbol,
                    side: side,
                    type: 'LIMIT',
                    price: crossPriceStr,
                    quantity: reduceQtyStr,
                    timeInForce: 'GTC',
                    reduceOnly: true
                };

                const closeRes = await sendSignedRequest(`https://testnet-futures-hpo.dcxstage.com/fapi/v1/order`, 'POST', payload, userCreds);
                if (closeRes.ok) {
                    log.success(this.symbol, `[REDUCE-POS] ${userLabel} successfully placed reduction LIMIT order.`);
                    return true;
                } else {
                    log.error(this.symbol, `[REDUCE-POS] Failed to reduce ${userLabel} position: ${JSON.stringify(closeRes.data || closeRes.error)}`);
                    return false;
                }
            };

            await Promise.all([
                reduceUser(globalUsers[globalRoles.makerId], 'USER1_MAKER'),
                reduceUser(globalUsers[globalRoles.takerId], 'USER2_TAKER')
            ]);
        } catch (err) {
            log.error(this.symbol, `[REDUCE-POS] Exception during position reduction: ${err.message}`);
        } finally {
            this.isReducingPositions = false;
        }
    }

    async cancelOrder(orderId, isTaker = false) {
        const userCreds = isTaker ? globalUsers[globalRoles.takerId] : globalUsers[globalRoles.makerId];
        const userLabel = isTaker ? 'USER2_TAKER' : 'USER1_MAKER';

        let price = null, side = null;
        if (!isTaker) {
            const b = this.restingBids.find(ro => ro && ro.orderId === orderId);
            const a = this.restingAsks.find(ro => ro && ro.orderId === orderId);
            if (b) { price = b.price; side = 'BUY'; }
            if (a) { price = a.price; side = 'SELL'; }
        }

        log.debug(this.symbol, `[CANCEL-PRE] ${userLabel} cancelling ID: ${orderId}`);
        const res = await sendSignedRequest(`https://testnet-futures-hpo.dcxstage.com/fapi/v1/order`, 'DELETE', { symbol: this.symbol, orderId }, userCreds);

        if (res.status === 401) this.handleAuthFailure(userLabel);
        if (res.ok) {
            log.debug(this.symbol, `[CANCEL-POST] Cancelled OK. ID: ${orderId}`);
            emitOrderEvent('order:cancelled', {
                symbol: this.symbol,
                orderId,
                isTaker,
                price,
                side,
                latencyMs: res.latencyMs
            });
        } else {
            const isBenign = res.data && [-2010, -2011, -2013, -4000].includes(res.data.code);
            if (isBenign) {
                log.warn(this.symbol, `[CANCEL-IGNORE] ID: ${orderId} message: ${res.data.msg}`);
            } else {
                log.error(this.symbol, `[CANCEL-FAIL] ID: ${orderId} failed: ${JSON.stringify(res.data || res.error)}`);
            }
            emitOrderEvent('order:cancel_failed', {
                symbol: this.symbol,
                orderId,
                isTaker,
                price,
                side,
                latencyMs: res.latencyMs,
                error: res.data || { msg: res.error }
            });
        }
        const isTerminal = res.ok || res.status === 404 || (res.data && [-2010, -2011, -2013, -4000].includes(res.data.code));
        return { success: res.ok, isTerminal };
    }

    handleAuthFailure(user) {
        if (!this.hasLoggedAuthError) {
            this.hasLoggedAuthError = true;
            log.critical(this.symbol, `Terminal 401 Unauthorized for ${user}. Check "Enable Futures" & IP Whitelist.`);
            this.pause();
        }
    }

    async processGhosts() {
        if (this.isCancellingGhosts) return;
        this.isCancellingGhosts = true;
        try {
            const queueArray = Array.from(this.ghostCancelQueue).filter(id => !this.inFlightCancels.has(id));
            for (let i = 0; i < queueArray.length; i += 10) {
                const chunk = queueArray.slice(i, i + 10);
                await Promise.allSettled(chunk.map(async (orderId) => {
                    this.inFlightCancels.add(orderId);
                    const res = await this.cancelOrder(orderId);
                    if (res.isTerminal) {
                        this.ghostCancelQueue.delete(orderId);
                        this.inFlightCancels.delete(orderId);
                        this.cancelRetries.delete(orderId);
                    } else {
                        const attempts = (this.cancelRetries.get(orderId) || 0) + 1;
                        this.cancelRetries.set(orderId, attempts);
                        this.inFlightCancels.delete(orderId);
                        if (attempts > 3) {
                            log.debug(this.symbol, `[GHOST-PRUNE] Abandoning ID ${orderId} after 3 failed cancel attempts.`);
                            this.ghostCancelQueue.delete(orderId);
                            this.cancelRetries.delete(orderId);
                        }
                    }
                }));
                await new Promise(r => setTimeout(r, 500));
            }
        } finally { this.isCancellingGhosts = false; }
    }

    async syncGrid(side, sourceLevels) {
        const guardKey = 'isSyncing' + side;
        if (this[guardKey]) return;
        this[guardKey] = true;
        try {
            ScenarioEngine.tick(this.symbol);
        const transformer = ScenarioEngine.getTransformer(this.symbol);

        const isBuy         = side === 'BUY';
        const restingOrders = isBuy ? this.restingBids : this.restingAsks;
        const tradeSync     = this.enableTradeSync;

        let skewedLevels = PriceTransformer.applyDepthSkew(sourceLevels, side, transformer);

        const targets = skewedLevels.slice(0, this.depthLevels).map((lvl, index) => {
            let rawPrice  = lvl[0];
            rawPrice = PriceTransformer.applyPriceAxes(rawPrice, side, transformer, index);
            const notional  = parseFloat(lvl[0]) * parseFloat(lvl[1]);
            const targetSz  = Math.max(this.minSize, Math.min(this.maxSize, notional));
            let qty       = calculateQty(targetSz, rawPrice, this.symbol);
            qty = PriceTransformer.applyProfileSkew(qty, side, transformer, index);
            return { rawPrice, price: formatPrice(rawPrice, this.symbol), qty };
        });

        let unmappedResting = [...restingOrders];
        let unmappedTargets = [...targets];
        const activePool    = [];
        const modifyBatch = [], placeBatch  = [], cancelBatch = [];

        for (let i = unmappedTargets.length - 1; i >= 0; i--) {
            const target = unmappedTargets[i];
            if (this.priceLocks.has(target.price)) {
                const idx = unmappedResting.findIndex(ro => ro && ro.price === target.price);
                if (idx !== -1) { activePool.push(unmappedResting[idx]); unmappedResting.splice(idx, 1); }
                unmappedTargets.splice(i, 1);
                continue;
            }

            const idx = unmappedResting.findIndex(ro => ro && ro.price === target.price);
            if (idx !== -1) {
                const matched = unmappedResting[idx];
                unmappedResting.splice(idx, 1);
                unmappedTargets.splice(i, 1);
                const orderStatus = (matched.status || 'NEW').toUpperCase();

                if (this.inFlightEdits.has(matched.orderId)) {
                    activePool.push(matched);
                } else if (orderStatus === 'PARTIALLY_FILLED') {
                    activePool.push(matched); 
                } else {
                    const diffPct = Math.abs(parseFloat(matched.qty) - parseFloat(target.qty)) / parseFloat(matched.qty);
                    if (diffPct > this.qtyChangeTolerance) {
                        this.inFlightEdits.add(matched.orderId);
                        modifyBatch.push((async () => {
                            const result = await this.modifyMaker(matched.orderId, side, target.rawPrice, target.qty);
                            this.inFlightEdits.delete(matched.orderId);
                            if (result.success) { matched.qty = target.qty; activePool.push(matched); } 
                            else if (!result.isTerminal) { activePool.push(matched); }
                        })());
                    } else { activePool.push(matched); }
                }
            }
        }

        for (let i = unmappedTargets.length - 1; i >= 0; i--) {
            const target = unmappedTargets[i];
            if (this.priceLocks.has(target.price)) continue;

            if (unmappedResting.length > 0) {
                const recyclableIdx = unmappedResting.findIndex(ro => (ro.status || 'NEW').toUpperCase() === 'NEW' && !this.inFlightEdits.has(ro.orderId));
                if (recyclableIdx !== -1) {
                    const recycled = unmappedResting[recyclableIdx];
                    unmappedResting.splice(recyclableIdx, 1);
                    this.inFlightEdits.add(recycled.orderId);
                    modifyBatch.push((async () => {
                        const result = await this.modifyMaker(recycled.orderId, side, target.rawPrice, target.qty);
                        this.inFlightEdits.delete(recycled.orderId);
                        if (result.success) { recycled.price = target.price; recycled.qty = target.qty; recycled.status = 'NEW'; recycled.createdAt = Date.now(); activePool.push(recycled); } 
                        else {
                            if (!result.isTerminal) activePool.push(recycled); 
                            const r = await this.placeOrder(side, target.qty, target.rawPrice, 'LIMIT');
                            if (r.success) activePool.push({ orderId: r.orderId, price: target.price, qty: target.qty, status: 'NEW', createdAt: Date.now() });
                        }
                    })());
                    unmappedTargets.splice(i, 1);
                    continue;
                }
                if (!tradeSync) { const pf = unmappedResting.pop(); activePool.push(pf); }
            }
            placeBatch.push(this.placeOrder(side, target.qty, target.rawPrice, 'LIMIT').then(r => r.success && activePool.push({ orderId: r.orderId, price: target.price, qty: target.qty, status: 'NEW', createdAt: Date.now() })));
            unmappedTargets.splice(i, 1);
        }

        const now = Date.now();
        const canCleanup = (now - (this.lastExcessCancelTime || 0)) > 3000;
        let cleanedUpCount = 0;

        for (const excess of unmappedResting) {
            const orderStatus = (excess.status || 'NEW').toUpperCase();
            if (this.inFlightEdits.has(excess.orderId) || !tradeSync || orderStatus === 'PARTIALLY_FILLED') {
                activePool.push(excess);
            } else if (canCleanup && cleanedUpCount < 5) {
                this.inFlightEdits.add(excess.orderId);
                cancelBatch.push(this.cancelOrder(excess.orderId).finally(() => this.inFlightEdits.delete(excess.orderId)));
                cleanedUpCount++;
            } else {
                activePool.push(excess);
            }
        }
        if (cleanedUpCount > 0) this.lastExcessCancelTime = now;

            await Promise.allSettled([...modifyBatch, ...placeBatch, ...cancelBatch]);
            if (isBuy) this.restingBids = activePool; else this.restingAsks = activePool;
        } finally { this[guardKey] = false; }
    }

    async refreshRestingStatuses(openOrdersData) {
        if (!Array.isArray(openOrdersData)) return;
        const statusMap = new Map();
        openOrdersData.forEach(o => statusMap.set(o.orderId || o.id, (o.status || 'NEW').toUpperCase()));
        for (const ro of [...this.restingBids, ...this.restingAsks]) {
            if (ro) {
                if (statusMap.has(ro.orderId)) ro.status = statusMap.get(ro.orderId);
                else ro.status = 'FILLED'; // Missing from openOrders means it's dead
            }
        }
    }

    async runDeltaSync() {
        if (manualOverride) return;
        if (this.status !== 'RUNNING' || this.isSyncingDelta) return;
        this.isSyncingDelta = true;
        this.totalSyncAttempts++;
        const startT = Date.now();

        try {
            const openRes = await sendSignedRequest(`https://testnet-futures-hpo.dcxstage.com/fapi/v1/openOrders`, 'GET', { symbol: this.symbol }, globalUsers[globalRoles.makerId]);
            if (openRes.status === 401) { this.handleAuthFailure('USER1_MAKER'); return; }

            if (openRes.ok && Array.isArray(openRes.data)) {
                await this.refreshRestingStatuses(openRes.data);
                const exchangeIds = new Set(openRes.data.map(o => String(o.orderId || o.id)));
                const now = Date.now();
                const retain = (ro) => ro && (exchangeIds.has(String(ro.orderId)) || (now - (ro.createdAt || 0) < 5000));
                this.restingBids  = this.restingBids.filter(retain);
                this.restingAsks  = this.restingAsks.filter(retain);

                const localIds = new Set([...this.restingBids.map(ro => String(ro.orderId)), ...this.restingAsks.map(ro => String(ro.orderId))]);
                const ghosts = openRes.data.filter(o => !localIds.has(String(o.orderId || o.id)));
                if (ghosts.length > 0) {
                    ghosts.forEach(o => {
                        const id = o.orderId || o.id;
                        if (!this.inFlightCancels.has(id)) this.ghostCancelQueue.add(id);
                    });
                    this.processGhosts();
                }
            } else {
                log.warn(this.symbol, `[DELTA-SYNC] openOrders failed/timed out. Falling back to local state.`);
            }

            await this.syncGrid('BUY',  this.binanceDepth.bids);
            await this.syncGrid('SELL', this.binanceDepth.asks);
            this.successfulSyncs++;
            this.testnetLatency = Date.now() - startT;
        } catch (err) { log.error(this.symbol, `Sync loop error: ${err.message}`); } 
        finally { this.isSyncingDelta = false; }
    }

    async handleTrade(trade) {
        if (this.status !== 'RUNNING' || !this.enableTradeSync) return;
        
        ScenarioEngine.tick(this.symbol);
        const transformer = ScenarioEngine.getTransformer(this.symbol);
        const transformedTradePrice = PriceTransformer.applyPriceAxes(trade.p, trade.m ? 'SELL' : 'BUY', transformer, 0);

        const pStr      = formatPrice(transformedTradePrice, this.symbol);
        const notional  = parseFloat(trade.q) * parseFloat(transformedTradePrice);
        const targetSz  = Math.max(this.minSize, Math.min(this.maxSize, notional));
        let scaledQty = calculateQty(targetSz, transformedTradePrice, this.symbol);

        const remainingScenarioQty = ScenarioEngine.getRemainingQty(this.symbol);
        if (remainingScenarioQty !== null) {
            if (remainingScenarioQty <= 0) return; // Freeze Taker if scenario condition is met
            scaledQty = Math.min(scaledQty, remainingScenarioQty);
            // Re-round to strict instrument specification to avoid LOT_SIZE rejection
            scaledQty = formatRawQty(scaledQty, this.symbol);
        }

        const makerSide = trade.m ? 'BUY' : 'SELL';
        const takerSide = trade.m ? 'SELL' : 'BUY';
        this.priceLocks.add(pStr);

        try {
            const restingPool   = makerSide === 'BUY' ? this.restingBids : this.restingAsks;
            const hasRestingMaker = restingPool.find(ro => ro && ro.price === pStr);
            let finalMakerId = hasRestingMaker ? hasRestingMaker.orderId : null;

            if (!hasRestingMaker) {
                const makerRes = await this.placeOrder(makerSide, scaledQty, transformedTradePrice, 'LIMIT');
                finalMakerId = makerRes.orderId;
                if (!makerRes.success) return; // If maker fails, we abort
            }

            if (this.tradeDelayMs > 0) await new Promise(r => setTimeout(r, this.tradeDelayMs));

            const clientOrderId = require('crypto').randomUUID();
            
            // Register in flight context immediately
            this.inFlightTakerOrders.set(clientOrderId, {
                makerOrderId: finalMakerId,
                limitPrice: pStr,
                expectedQty: String(scaledQty),
                binanceQty: trade.q,
                ts: Date.now()
            });

            emitOrderEvent('order:fill_attempt', {
                symbol: this.symbol,
                makerOrderId: finalMakerId,
                takerOrderId: 'pending_ws',
                expectedQty: scaledQty,
                price: transformedTradePrice
            });

            const takerRes = await this.placeOrder(takerSide, scaledQty, transformedTradePrice, 'LIMIT_IOC', true, clientOrderId);
            
            if (!takerRes.success) {
                // HTTP rejection (e.g. margin limit). Push failure immediately to UI
                this.inFlightTakerOrders.delete(clientOrderId);
                this.syncedTrades.unshift({
                    id: crypto.randomUUID(),
                    time: getISTTimeString(),
                    price: pStr,
                    avgPrice: null,
                    side: takerSide,
                    binanceQty: trade.q,
                    stageQty: String(scaledQty),
                    success: false,
                    status: 'FAILED',
                    makerOrderId: finalMakerId,
                    takerOrderId: 'failed'
                });
                if (this.syncedTrades.length > 5000) this.syncedTrades.pop();

                emitOrderEvent('order:fill_failed', {
                    symbol: this.symbol,
                    makerOrderId: finalMakerId,
                    error: { msg: 'Taker limit IOC placement failed at HTTP level' }
                });
            } else {
                // Fallback if WS is not configured or disconnected
                if (!this.takerWs || !this.takerWs.ws || this.takerWs.ws.readyState !== 1) {
                    
                    // Poll for final status if we only got an intermediate state
                    let finalTakerRes = takerRes;
                    if (takerRes.status === 'CREATE_IN_PROGRESS' || takerRes.status === 'NEW') {
                        await new Promise(r => setTimeout(r, 150)); // Give matching engine time to process IOC
                        try {
                            const checkRes = await sendSignedRequest(`https://testnet-futures-hpo.dcxstage.com/fapi/v1/order`, 'GET', { symbol: this.symbol, orderId: takerRes.orderId }, globalUsers[globalRoles.takerId]);
                            if (checkRes.ok && checkRes.data) {
                                finalTakerRes = {
                                    ...takerRes,
                                    status: checkRes.data.status,
                                    executedQty: checkRes.data.executedQty,
                                    avgPrice: checkRes.data.avgPrice
                                };
                            }
                        } catch(e) { log.debug && log.debug('SYSTEM', e.message); }
                    }

                    const executedQty = finalTakerRes.executedQty || String(scaledQty);
                    this.inFlightTakerOrders.delete(clientOrderId);
                    this.syncedTrades.unshift({
                        id: crypto.randomUUID(),
                        time: getISTTimeString(),
                        price: pStr,
                        avgPrice: finalTakerRes.avgPrice || null,
                        side: takerSide,
                        binanceQty: trade.q,
                        stageQty: executedQty,
                        success: true,
                        status: finalTakerRes.status && finalTakerRes.status !== 'CREATE_IN_PROGRESS' ? finalTakerRes.status : 'FILLED',
                        makerOrderId: finalMakerId,
                        takerOrderId: finalTakerRes.orderId
                    });
                    if (this.syncedTrades.length > 5000) this.syncedTrades.pop();

                    emitOrderEvent('order:fill_success', {
                        symbol: this.symbol,
                        makerOrderId: finalMakerId,
                        takerOrderId: finalTakerRes.orderId,
                        price: transformedTradePrice,
                        executedQty: executedQty
                    });
                }
            }

            ScenarioEngine.reportExecution(this.symbol, scaledQty);

        } finally { this.priceLocks.delete(pStr); }
    }

    async processTradeQueue() {
        if (manualOverride) return;
        if (this.tradeQueue.length > 50) this.tradeQueue.splice(0, this.tradeQueue.length - 20);
        if (this.isCrossing) return;
        this.isCrossing = true;
        try {
            while (this.tradeQueue.length > 0) await this.handleTrade(this.tradeQueue.shift());
        } catch(e) {
            log.error(this.sourceSymbol, `Trade queue error: ${e.message}`);
        } finally {
            this.isCrossing = false;
        }
    }

startBinanceDepthWS() {
        if (this.wsBinanceDepth) return;
        const startTime = Date.now();
        const sym = this.sourceSymbol.toLowerCase(); // Using Source Symbol
        const url = `wss://fstream.binance.com/public/ws/${sym}@depth20@100ms`;

        this.wsBinanceDepth = new WebSocket(url);
        this.wsBinanceDepth.on('open', () => { pushEvent('SUCCESS', this.symbol, `Binance Depth WS connected`, { stream: 'depth' }, 'ws'); this.binanceLatency = Date.now() - startTime; });
        this.wsBinanceDepth.on('message', (raw) => {
            if (this.status === 'STOPPED') return;
            try {
                const data = JSON.parse(raw.toString());
                const bids = data.bids || data.b;
                const asks = data.asks || data.a;
                
                if (bids && asks) {
                    this.binanceDepth.bids = bids.slice(0, this.depthLevels);
                    this.binanceDepth.asks = asks.slice(0, this.depthLevels);
                    this.syncGrid('BUY', this.binanceDepth.bids);
                    this.syncGrid('SELL', this.binanceDepth.asks);
                    const bestBid = bids[0] ? bids[0][0] : '-';
                    const bestAsk = asks[0] ? asks[0][0] : '-';
                    const spread = (bestBid !== '-' && bestAsk !== '-') ? (parseFloat(bestAsk) - parseFloat(bestBid)).toFixed(2) : '-';
                    pushEvent('EVENT', this.symbol, `Binance Depth | Bid: $${bestBid} | Ask: $${bestAsk} | Spread: $${spread} | Levels: ${bids.length}/${asks.length}`, data, 'depth');
                }
            } catch (e) { log.debug && log.debug('SYSTEM', e.message); }
        });
        this.wsBinanceDepth.on('error', (err) => { pushEvent('ERROR', this.symbol, `Binance Depth WS error: ${err.message}`, null, 'ws'); });
        this.wsBinanceDepth.on('close', () => { pushEvent('WARN', this.symbol, `Binance Depth WS disconnected — reconnecting...`, null, 'ws'); this.wsBinanceDepth = null; if (this.status !== 'STOPPED') setTimeout(() => this.startBinanceDepthWS(), 3000); });
    }

    startBinanceTradesWS() {
        if (this.wsBinanceTrades) return;
        const sym = this.sourceSymbol.toLowerCase(); // Using Source Symbol
        const url = `wss://fstream.binance.com/market/ws/${sym}@aggTrade`;

        this.wsBinanceTrades = new WebSocket(url);
        this.wsBinanceTrades.on('open', () => { pushEvent('SUCCESS', this.symbol, `Binance Trades WS connected`, { stream: 'aggTrade' }, 'ws'); });
        this.wsBinanceTrades.on('message', (raw) => {
            if (this.status === 'STOPPED') return;
            try {
                const data = JSON.parse(raw.toString());
                if (data.e === 'aggTrade') {
                    this.binanceLtp = data.p;
                    const side = data.m ? 'SELL' : 'BUY';
                    pushEvent('EVENT', this.symbol, `Trade | ${side} | Price: $${data.p} | Qty: ${data.q}`, data, 'trade');
                    if (this.enableTradeSync) {
                        this.tradeQueue.push({ p: data.p, q: data.q, m: data.m });
                        this.processTradeQueue();
                    }
                }
            } catch (e) { log.debug && log.debug('SYSTEM', e.message); }
        });
        this.wsBinanceTrades.on('error', (err) => { pushEvent('ERROR', this.symbol, `Binance Trades WS error: ${err.message}`, null, 'ws'); });
        this.wsBinanceTrades.on('close', () => { pushEvent('WARN', this.symbol, `Binance Trades WS disconnected — reconnecting...`, null, 'ws'); this.wsBinanceTrades = null; if (this.status !== 'STOPPED') setTimeout(() => this.startBinanceTradesWS(), 3000); });
    }


    startTestnetTickerWS() {
        if (this.wsTestnetTicker) return;
        const sym = this.symbol.toLowerCase();
        const streamUrl = `wss://testnet-futures-socket-gateway.dcxstage.com/market/ws/${sym}@ticker`;
        log.info(this.symbol, `[WS] Connecting to 24h Ticker...`);
        this.wsTestnetTicker = new WebSocket(streamUrl);
        this.wsTestnetTicker.on('open', () => { pushEvent('SUCCESS', this.symbol, `Testnet Ticker WS connected`, { stream: '24hrTicker' }, 'ws'); });
        this.wsTestnetTicker.on('message', (raw) => {
            if (this.status === 'STOPPED') return;
            try {
                const data = JSON.parse(raw.toString());
                if (data.e === '24hrTicker') {
                    this.testnetLtp = parseFloat(data.c);
                    pushEvent('EVENT', this.symbol, `Ticker | LTP: $${parseFloat(data.c).toFixed(2)} | 24h Vol: ${parseFloat(data.v || 0).toFixed(0)} | Change: ${parseFloat(data.P || 0).toFixed(2)}%`, data, 'ticker');
                    broadcastToUI();
                }
            } catch(e) { log.debug && log.debug('SYSTEM', e.message); }
        });
        this.wsTestnetTicker.on('close', () => { pushEvent('WARN', this.symbol, `Testnet Ticker WS disconnected — reconnecting...`, null, 'ws'); this.wsTestnetTicker = null; if (this.status !== 'STOPPED') setTimeout(() => this.startTestnetTickerWS(), 3000); });
        this.wsTestnetTicker.on('error', (err) => { pushEvent('ERROR', this.symbol, `Testnet Ticker WS error: ${err.message}`, null, 'ws'); });
    }



    startTestnetWS() {
        clearInterval(this.testnetPingInterval);
        if (this.wsTestnet) return;
        const sym = this.symbol.toLowerCase(); // Target Symbol
        const streamUrl = `wss://testnet-futures-socket-gateway.dcxstage.com/public/ws/${sym}@depth20`;
        this.wsTestnet = new WebSocket(streamUrl);
        this.wsTestnet.on('open', () => {
            pushEvent('SUCCESS', this.symbol, `Testnet Depth WS connected`, { stream: 'depth20' }, 'ws');
            this.testnetPingInterval = setInterval(() => { if (this.wsTestnet && this.wsTestnet.readyState === WebSocket.OPEN) this.wsTestnet.ping(); }, 30000);
        });

        this.wsTestnet.on('message', (raw) => {
            if (this.status === 'STOPPED') return;
            try {
                const data = JSON.parse(raw.toString());
                const bids = data.bids || data.b;
                const asks = data.asks || data.a;
                
                if (bids && asks) {
                    this.testnetDepth.bids = bids.slice(0, this.depthLevels);
                    this.testnetDepth.asks = asks.slice(0, this.depthLevels);
                    broadcastToUI();
                    const bestBid = bids[0] ? bids[0][0] : '-';
                    const bestAsk = asks[0] ? asks[0][0] : '-';
                    const spread = (bestBid !== '-' && bestAsk !== '-') ? (parseFloat(bestAsk) - parseFloat(bestBid)).toFixed(2) : '-';
                    pushEvent('EVENT', this.symbol, `Testnet Depth | Bid: $${bestBid} | Ask: $${bestAsk} | Spread: $${spread} | Levels: ${bids.length}/${asks.length}`, data, 'depth');
                }
            } catch (e) { log.debug && log.debug('SYSTEM', e.message); }
        });
        this.wsTestnet.on('error', (err) => { pushEvent('ERROR', this.symbol, `Testnet Depth WS error: ${err.message}`, null, 'ws'); });
        this.wsTestnet.on('close', () => { clearInterval(this.testnetPingInterval); pushEvent('WARN', this.symbol, `Testnet Depth WS disconnected — reconnecting...`, null, 'ws'); this.wsTestnet = null; if (this.status !== 'STOPPED') setTimeout(() => this.startTestnetWS(), 3000); });
    }

    async wipeOrders() {
        log.info(this.symbol, 'Wiping orders (15s timeout)...');
        const [u1Res, u2Res] = await Promise.all([
            sendSignedRequest(`https://testnet-futures-hpo.dcxstage.com/fapi/v1/openOrders`, 'GET', { symbol: this.symbol }, globalUsers[globalRoles.makerId], 15000),
            sendSignedRequest(`https://testnet-futures-hpo.dcxstage.com/fapi/v1/openOrders`, 'GET', { symbol: this.symbol }, globalUsers[globalRoles.takerId], 15000)
        ]);

        let toCancel = [];
        if (u1Res.ok && Array.isArray(u1Res.data)) toCancel.push(...u1Res.data.map(o => ({ id: o.orderId, isTaker: false })));
        if (u2Res.ok && Array.isArray(u2Res.data)) toCancel.push(...u2Res.data.map(o => ({ id: o.orderId, isTaker: true })));

        if (toCancel.length > 0) {
            await Promise.allSettled(toCancel.map(o => this.cancelOrder(o.id, o.isTaker)));
            log.success(this.symbol, 'Staging book cleansed.');
        }
        this.restingBids = []; this.restingAsks = [];
    }

    async reloadDepth() {
        const depthEndpoints = [
            `https://testnet-futures-hpo.dcxstage.com/fapi/v1/depth?symbol=${this.symbol}&limit=${this.depthLevels}`,
            `https://testnet-futures-hpo.dcxstage.com/api/v1/derivatives/futures/depth?symbol=${this.symbol}&limit=${this.depthLevels}`
        ];
        for (const endpoint of depthEndpoints) {
            try {
                const res = await fetch(endpoint);
                if (res.ok) {
                    const data = await res.json();
                    if (data.bids && data.asks) { this.testnetDepth = { bids: data.bids, asks: data.asks }; broadcastToUI(); break; }
                }
            } catch (e) { log.debug && log.debug('SYSTEM', e.message); }
        }
        if (this.wsTestnet) { clearInterval(this.testnetPingInterval); this.wsTestnet.removeAllListeners('close'); this.wsTestnet.close(); this.wsTestnet = null; }
        this.startTestnetWS();
        this.startTestnetTickerWS();

    }

    async start() {
        if (this.status === 'RUNNING') return;
        
        if (this.newUserFlow && !this.hasStartedBefore) {
            log.info(this.symbol, `New User Flow active. Sleeping for 120 seconds before starting...`);
            await new Promise(r => setTimeout(r, 120000));
            this.hasStartedBefore = true;
        }

        this.status = 'RUNNING'; this.hasLoggedAuthError = false;
        log.success(this.symbol, 'Engine Started.');
        
        try {
            log.info(this.symbol, 'Fetching initial Binance price for LTP alignment check...');
            const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${this.sourceSymbol}`);
            if (res.ok) {
                const data = await res.json();
                if (data && data.price) {
                    await this.alignLtpToTarget(parseFloat(data.price));
                }
            }
        } catch (e) {
            log.error(this.symbol, `Initial alignment fetch failed: ${e.message}`);
        }

        await this.reloadDepth();
        this.startBinanceDepthWS();
        this.startBinanceTradesWS();
    }

    pause() { this.status = 'PAUSED'; log.warn(this.symbol, 'Engine Paused.'); }

    async stop() {
        this.status = 'STOPPED'; log.warn(this.symbol, 'Engine Stopped.');
        if (this.wsBinanceDepth)  { this.wsBinanceDepth.removeAllListeners('close');  this.wsBinanceDepth.close();  this.wsBinanceDepth = null; }
        if (this.wsBinanceTrades) { this.wsBinanceTrades.removeAllListeners('close'); this.wsBinanceTrades.close(); this.wsBinanceTrades = null; }
        if (this.wsTestnet) { clearInterval(this.testnetPingInterval); this.wsTestnet.removeAllListeners('close'); this.wsTestnet.close(); this.wsTestnet = null; }
        if (this.wsTestnetTicker) { try { this.wsTestnetTicker.removeAllListeners('close'); this.wsTestnetTicker.close(); } catch(e) { /* intentional: WS may already be closed */ } this.wsTestnetTicker = null; }
        if (this.cancelOnStop) await this.wipeOrders(); else { this.restingBids = []; this.restingAsks = []; }
    }
}

const instances = new Map();
let manualOverride = false;

// ==========================================
// 4. Global Portfolio & Master Loop
// ==========================================
function autoParsePositions(data) {
    if (!Array.isArray(data)) return [];
    return data.filter(pos => parseFloat(pos.positionAmt || pos.size || 0) !== 0).map(pos => {
        const amt  = parseFloat(pos.positionAmt || pos.size || 0);
        const inst = instrumentsMap[pos.symbol] || { pricePrecision: 4, qtyPrecision: 3 };
        return {
            symbol:        pos.symbol,
            side:          amt > 0 ? 'LONG' : 'SHORT',
            size:          Math.abs(amt).toFixed(inst.qtyPrecision),
            entryPrice:    parseFloat(pos.entryPrice || 0).toFixed(inst.pricePrecision),
            markPrice:     parseFloat(pos.markPrice  || 0).toFixed(inst.pricePrecision),
            unrealizedPnL: parseFloat(pos.unRealizedProfit || pos.unrealizedProfit || 0).toFixed(2),
            leverage:      pos.leverage || "1",
            liqPrice:      parseFloat(pos.liquidationPrice || 0).toFixed(inst.pricePrecision),
            margin:        parseFloat(pos.isolatedWallet || pos.currentMargin || 0).toFixed(2)
        };
    });
}

function autoParseAccount(data) {
    const parsed = { walletBalance: "0.00", availableBalance: "0.00", unrealizedProfit: "0.00" };
    if (!data) return parsed;
    const usdtAsset = (data.assets || []).find(a => a.asset === 'USDT');
    if (usdtAsset) {
        parsed.walletBalance    = parseFloat(usdtAsset.balance || usdtAsset.walletBalance || 0).toFixed(2);
        parsed.availableBalance = parseFloat(usdtAsset.availableBalance || 0).toFixed(2);
        parsed.unrealizedProfit = parseFloat(usdtAsset.unrealizedProfit || usdtAsset.unrealized_profit || 0).toFixed(2);
    }
    return parsed;
}

async function getUserPortfolio(userConfig) {
    let accountData = null, positionData = null, errorMsg = null;
    let res = await sendSignedRequest(`https://testnet-futures-hpo.dcxstage.com/fapi/v2/account`, 'GET', null, userConfig);
    if (res.ok) accountData = res.data;
    else if (res.status === 401) errorMsg = `API Failed (401 Unauthorized)`;
    else errorMsg = `API Failed (${res.status})`;

    let posRes = await sendSignedRequest(`https://testnet-futures-hpo.dcxstage.com/fapi/v2/positionRisk`, 'GET', null, userConfig);
    if (posRes.ok) positionData = posRes.data;
    else if (!errorMsg) errorMsg = `Positions API Failed (${posRes.status})`;

    const portfolio = { walletBalance: "0.00", availableBalance: "0.00", unrealizedProfit: "0.00", positions: [], openOrders: [], orderHistory: [], openOrdersCount: 0, error: errorMsg };
    if (accountData) {
        const pAcc = autoParseAccount(accountData);
        portfolio.walletBalance    = pAcc.walletBalance;
        portfolio.availableBalance = pAcc.availableBalance;
        portfolio.unrealizedProfit = pAcc.unrealizedProfit;
    }
    if (positionData) portfolio.positions = autoParsePositions(positionData);
    return portfolio;
}

let globalPortfolios = {};
let _prevPortfolioState = {}; // Track previous state for change detection

async function globalMasterLoop() {
    try {
        const syncPromises = [];
        for (const [, inst] of instances.entries()) {
            if (inst.status === 'RUNNING') syncPromises.push(inst.runDeltaSync());
        }
        await Promise.allSettled(syncPromises);

        const now = Date.now();
        if (lastPortfolioSyncTime === 0 || now - lastPortfolioSyncTime >= PORTFOLIO_SYNC_INTERVAL_MS) {
            lastPortfolioSyncTime = now;
            
            const userKeys = Object.keys(globalUsers);
            const portPromises = userKeys.map(k => getUserPortfolio(globalUsers[k]));
            const results = await Promise.allSettled(portPromises);
            
            userKeys.forEach((k, i) => {
                if (results[i].status === 'fulfilled') {
                    const newPort = results[i].value;
                    const prevPort = _prevPortfolioState[k];
                    const uLabel = globalUsers[k].label || k;

                    const newWallet = parseFloat(newPort.walletBalance || 0);
                    const newAvail = parseFloat(newPort.availableBalance || 0);
                    const newPnl = parseFloat(newPort.unrealizedProfit || 0);
                    const pnlSign = newPnl >= 0 ? '+' : '';

                    // Always push account state on every poll
                    pushEvent('EVENT', uLabel, `Account | Wallet: $${newWallet.toFixed(2)} | Available: $${newAvail.toFixed(2)} | PnL: ${pnlSign}$${newPnl.toFixed(2)}`, { walletBalance: newWallet, availableBalance: newAvail, unrealizedProfit: newPnl }, 'account');

                    // Balance change detection (delta)
                    if (prevPort) {
                        const prevWallet = parseFloat(prevPort.walletBalance || 0);
                        if (Math.abs(newWallet - prevWallet) > 0.001) {
                            const delta = (newWallet - prevWallet).toFixed(4);
                            const sign = newWallet > prevWallet ? '+' : '';
                            pushEvent('EVENT', uLabel, `Balance Changed | Wallet: $${newWallet.toFixed(2)} (${sign}${delta})`, { walletBalance: newWallet, delta: parseFloat(delta) }, 'balance');
                        }
                    }

                    // Always push position state on every poll
                    const allPositions = (newPort.positions || []);
                    const activePositions = allPositions.filter(p => parseFloat(p.positionAmt || p.size || 0) !== 0);
                    if (activePositions.length > 0) {
                        activePositions.forEach(p => {
                            const amt = p.positionAmt || p.size || '0';
                            const entry = p.entryPrice || p.avgPrice || '-';
                            const upnl = parseFloat(p.unrealizedProfit || p.pnl || 0);
                            const pSign = upnl >= 0 ? '+' : '';
                            pushEvent('EVENT', uLabel, `Position | ${p.symbol || '?'} | Amt: ${amt} | Entry: $${parseFloat(entry).toFixed(2)} | PnL: ${pSign}$${upnl.toFixed(2)}`, p, 'position');
                        });
                    } else {
                        pushEvent('EVENT', uLabel, `Position | No active positions`, { positions: [] }, 'position');
                    }

                    _prevPortfolioState[k] = { walletBalance: newPort.walletBalance, availableBalance: newPort.availableBalance, unrealizedProfit: newPort.unrealizedProfit, positions: newPort.positions };
                    globalPortfolios[k] = newPort;
                }
            });

            // Track open orders via REST (since private WS listenKey is unavailable)
            for (const [, inst] of instances.entries()) {
                if (inst.status !== 'RUNNING') continue;
                const bidCount = (inst.restingBids || []).length;
                const askCount = (inst.restingAsks || []).length;
                const totalOrders = bidCount + askCount;
                if (totalOrders > 0) {
                    pushEvent('EVENT', inst.symbol, `Orders | Open: ${totalOrders} (${bidCount} bids, ${askCount} asks)`, { bids: bidCount, asks: askCount, total: totalOrders }, 'order');
                } else {
                    pushEvent('EVENT', inst.symbol, `Orders | No open orders`, { total: 0 }, 'order');
                }
            }
        }
    } catch (e) { log.debug && log.debug('SYSTEM', e.message); }
    finally {
        broadcastToUI();
        // The loop interval is now configured per-market, but we need a master loop.
        // We'll just run it every 1 second as a fallback.
        setTimeout(globalMasterLoop, 1000);
    }
}

// ==========================================
// 5. Server & UI Handling
// ==========================================
function buildPayload(isSnapshot = true, sinceTs = 0) {
    const activeInstancesMap = {};
    for (const [sym, inst] of instances.entries()) {
        const pData = instrumentsMap[sym] || { pricePrecision: 4, qtyPrecision: 1 };
        activeInstancesMap[sym] = {
            status:       inst.status,
            binanceDepth: inst.binanceDepth,
            testnetDepth: inst.testnetDepth,
            syncedTrades: inst.syncedTrades,
            diagnostics: {
                sourceSymbol:    inst.sourceSymbol,
                testnetLatency:  inst.testnetLatency,
                testnetLtp:      inst.testnetLtp,
                testnetKline:    inst.testnetKline,
                binanceLatency:  inst.binanceLatency,
                binanceLtp:      inst.binanceLtp,
                syncRatio:       inst.totalSyncAttempts > 0 ? ((inst.successfulSyncs / inst.totalSyncAttempts) * 100).toFixed(1) : '100',
                pricePrecision:  pData.pricePrecision !== undefined ? pData.pricePrecision : 4,
                qtyPrecision:    pData.qtyPrecision !== undefined ? pData.qtyPrecision : 1,
                bufferPct:       inst.bufferPct,
                cancelOnStop:    inst.cancelOnStop,
                newUserFlow:     inst.newUserFlow,
                tradeDelayMs:    inst.tradeDelayMs,
                enableTradeSync: inst.enableTradeSync
            },
            scenarioStatus: ScenarioEngine.getStatus(sym)
        };
    }
    
    // We send globalUsers keys (without secrets) and roles to the UI
    const usersMetadata = Object.keys(globalUsers).reduce((acc, k) => {
        acc[k] = { label: globalUsers[k].label, key: globalUsers[k].key, email: globalUsers[k].email };
        return acc;
    }, {});
    
    return JSON.stringify({ 
        instances: activeInstancesMap, 
        portfolios: globalPortfolios,
        users: usersMetadata,
        roles: globalRoles,
        terminalLogs,
        terminalEvents: isSnapshot ? terminalEvents : terminalEvents.filter(e => e.ts > sinceTs),
        orderUpdateCounter: globalOrderUpdateCounter
    });
}

let lastBroadcastTime = 0;
let lastBroadcastEventsTs = 0;
function broadcastToUI() {
    const now = Date.now();
    if (now - lastBroadcastTime < 1000) return;
    const sinceTs = lastBroadcastTime;
    lastBroadcastTime = now;
    const payload = buildPayload(false, sinceTs);
    // Push to any connected SSE browser clients — filter out dead connections
    if (sseClients.length > 0) {
        sseClients = sseClients.filter(c => {
            try { c.write(`data: ${payload}\n\n`); return true; }
            catch(e) { try { c.end(); } catch(x) {} return false; }
        });
    }
    // Always write to state file so Jenkins userContent UI can poll it
    writeStateFile(payload);
}

const server = http.createServer(async (req, res) => {
    // M7: CORS headers for all requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-replicator-user');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

    if (req.url === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        res.flushHeaders();
        res.write('\n');
        sseClients.push(res);
        res.on('error', () => { sseClients = sseClients.filter(c => c !== res); });
        res.on('close',  () => { sseClients = sseClients.filter(c => c !== res); });
        try {
            const snapshot = buildPayload();
            res.write(`data: ${snapshot}\n\n`);
        } catch (e) { log.debug && log.debug('SYSTEM', e.message); }
        return;
    }

    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; if (body.length > 1e6) { req.destroy(); return; } });
        req.on('end', async () => {
            try {
                const parsed = JSON.parse(body);
                const sym = parsed.symbol ? parsed.symbol.toUpperCase() : null;
                const targetSym = parsed.targetSymbol ? parsed.targetSymbol.toUpperCase() : sym;
                
                // Allow specific routes to omit symbol
                if (!sym && !req.url.startsWith('/api/users') && !req.url.startsWith('/api/manual-override')) {
                    throw new Error("Symbol is required");
                }
                if (req.url.startsWith('/fapi/')) {
                    const userId = req.headers['x-replicator-user'];
                    if (!userId) { res.writeHead(400); return res.end(JSON.stringify({ error: "Missing x-replicator-user header" })); }
                    const userCreds = globalUsers[userId];
                    if (!userCreds) { res.writeHead(400); return res.end(JSON.stringify({ error: "Invalid user ID" })); }
                    try {
                        const httpMethod = parsed._method || 'POST';
                        delete parsed._method;
                        const apiRes = await sendSignedRequest(`https://testnet-futures-hpo.dcxstage.com${req.url}`, httpMethod, parsed, userCreds);
                        if (apiRes.ok || (apiRes.status >= 200 && apiRes.status < 300)) {
                            // Force an immediate UI portfolio refresh in the global loop
                            lastPortfolioSyncTime = 0;
                        }
                        res.writeHead(apiRes.status || 200, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify(apiRes.data || {}));
                    } catch (e) {
                        res.writeHead(500); return res.end(JSON.stringify({ error: e.message }));
                    }
                }

                if (req.url.startsWith('/api/scenario/preset/')) {
                    const presetName = req.url.split('/').pop().split('?')[0];
                    if (!/^[a-zA-Z0-9_-]+$/.test(presetName)) { res.writeHead(400).end(JSON.stringify({ error: 'Invalid preset name' })); return; }
                    const presetPath = path.join(__dirname, 'scenarios', `${presetName}.json`);
                    if (!fs.existsSync(presetPath)) { res.writeHead(404); return res.end(JSON.stringify({ error: `Preset ${presetName} not found` })); }
                    const presetCfg = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
                    Object.assign(presetCfg, parsed);
                    try {
                        const state = ScenarioEngine.startScenario(sym, presetCfg);
                        res.writeHead(200); return res.end(JSON.stringify({ success: true, state }));
                    } catch (e) {
                        res.writeHead(400); return res.end(JSON.stringify({ error: e.message }));
                    }
                }

                if (req.url === '/api/scenario/custom') {
                    try {
                        const inst = instances.get(targetSym);
                        const currentLtp = inst ? inst.binanceLtp : null;
                        const state = ScenarioEngine.startScenario(sym, parsed, currentLtp);
                        res.writeHead(200); return res.end(JSON.stringify({ success: true, state }));
                    } catch (e) {
                        res.writeHead(400); return res.end(JSON.stringify({ error: e.message }));
                    }
                }

                if (req.url === '/api/config') {
                    let inst = instances.get(targetSym);
                    if (!inst) {
                        inst = new ReplicatorInstance({
                            sourceSymbol: sym,
                            targetSymbol: targetSym,
                            minSize: parseFloat(parsed.minSize || 100),
                            maxSize: parseFloat(parsed.maxSize || 500),
                            depthLevels: parseInt(parsed.depthLevels || 10),
                            bufferPct: parseFloat(parsed.bufferPct || 0),
                            tradeDelayMs: parseInt(parsed.tradeDelayMs || 0),
                            cancelOnStop: Boolean(parsed.cancelOnStop),
                            newUserFlow: Boolean(parsed.newUserFlow),
                            enableTradeSync: parsed.enableTradeSync !== false
                        });
                        instances.set(targetSym, inst);
                        inst.start().catch(e => log.error(targetSym, `Start failed: ${e.message}`));
                        log.info(targetSym, `New market mounted from UI.`);
                    } else {
                        if (parsed.minSize     !== undefined) inst.minSize     = parseFloat(parsed.minSize);
                        if (parsed.maxSize     !== undefined) inst.maxSize     = parseFloat(parsed.maxSize);
                        if (parsed.depthLevels !== undefined) inst.depthLevels = parseInt(parsed.depthLevels);
                        if (parsed.bufferPct   !== undefined) inst.bufferPct   = parseFloat(parsed.bufferPct);
                        if (parsed.cancelOnStop !== undefined) inst.cancelOnStop = Boolean(parsed.cancelOnStop);
                        if (parsed.tradeDelayMs !== undefined) inst.tradeDelayMs = parseInt(parsed.tradeDelayMs);
                        if (parsed.newUserFlow !== undefined) inst.newUserFlow = Boolean(parsed.newUserFlow);
                        if (parsed.enableTradeSync !== undefined) inst.enableTradeSync = Boolean(parsed.enableTradeSync);
                        log.info(targetSym, `Config updated for existing instance.`);
                    }

                } else if (req.url === '/api/manual-override') {
                    manualOverride = Boolean(parsed.locked);
                    log.info('SYSTEM', `Manual override set to ${manualOverride}`);
                } else if (req.url === '/api/users') {
                    if (parsed.action === 'add' || parsed.action === 'update') {
                        const { id, label, key, secret, listenKey } = parsed.user;
                        if (!id) throw new Error("User ID is required");
                        globalUsers[id] = { label: label || id, key: key || '', secret: secret || '', listenKey: listenKey || '' };
                        lastPortfolioSyncTime = 0;
                        log.info('SYSTEM', `User ${id} saved.`);
                    } else if (parsed.action === 'setRoles') {
                        if (parsed.makerId) globalRoles.makerId = parsed.makerId;
                        if (parsed.takerId) globalRoles.takerId = parsed.takerId;
                        lastPortfolioSyncTime = 0;
                        log.info('SYSTEM', `Roles updated: Maker=${globalRoles.makerId}, Taker=${globalRoles.takerId}`);
                    } else if (parsed.action === 'generate') {
                        const id = parsed.id;
                        if (!id) throw new Error("User ID is required for generation");
                        if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid user ID format');
                        log.info('SYSTEM', `Generating new user credentials for ${id}...`);
                        const { execFile } = require('child_process');
                        const execFileAsync = require('util').promisify(execFile);
                        const { stdout } = await execFileAsync('node', ['scripts/generate-single.js', id]);
                        const result = JSON.parse(stdout.trim());
                        globalUsers[id] = { label: id, key: result.key, secret: result.secret, email: result.email, listenKey: '' };
                        lastPortfolioSyncTime = 0;
                        log.info('SYSTEM', `User ${id} generated successfully.`);
                    } else if (parsed.action === 'delete') {
                        const id = parsed.id;
                        if (globalRoles.makerId === id || globalRoles.takerId === id) {
                            throw new Error("Cannot delete a user currently assigned as Maker or Taker.");
                        }
                        delete globalUsers[id];
                        delete globalPortfolios[id];
                        log.info('SYSTEM', `User ${id} deleted.`);
                    }
                } else {
                    const inst = instances.get(targetSym);
                    if (req.url === '/api/engine/start'  && inst) inst.start();
                    else if (req.url === '/api/engine/pause'  && inst) inst.pause();
                    else if (req.url === '/api/engine/stop'   && inst) await inst.stop();
                    else if (req.url === '/api/engine/reload' && inst) inst.reloadDepth();
                }
                res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true }));
            } catch (err) {
                res.writeHead(400);
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
        return;
    }

    if (req.method === 'DELETE') {
        let body = '';
        req.on('data', chunk => { body += chunk; if (body.length > 1e6) { req.destroy(); return; } });
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body);
                const sym = parsed.symbol ? parsed.symbol.toUpperCase() : null;
                if (!sym) throw new Error("Symbol is required");
                
                if (req.url === '/api/scenario/active') {
                    const aborted = ScenarioEngine.abortScenario(sym);
                    res.writeHead(200); return res.end(JSON.stringify({ success: true, aborted }));
                }
            } catch (e) {
                res.writeHead(400); return res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url === '/api/snapshot' && req.method === 'GET') {
        try {
            const payload = buildPayload();
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }).end(payload);
        } catch (e) {
            res.writeHead(500).end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(getHtmlUI());
        return;
    }
    res.writeHead(404).end();
});

// ==========================================
// 6. Main Execution Control
// ==========================================

async function startBots() {
    log.success('SYSTEM', '===========================================================');
    log.success('SYSTEM', `Starting ${marketConfigs.length} market replicator(s)...`);
    log.success('SYSTEM', '===========================================================');

    await Promise.allSettled([syncServerTime(), loadInstruments()]);
    
    // Fetch listen keys and connect user data streams for real-time events
    await fetchListenKeys();
    startListenKeyKeepalive();
    
    for (const marketConf of marketConfigs) {
        const targetSym = (marketConf.targetSymbol || marketConf.sourceSymbol).toUpperCase();
        if (instances.has(targetSym)) {
            log.warn(targetSym, 'Skipping duplicate market configuration.');
            continue;
        }
        log.info(targetSym, `Initializing market: ${marketConf.sourceSymbol} -> ${targetSym}`);
        const inst = new ReplicatorInstance(marketConf);
        instances.set(targetSym, inst);
    }

    const startPromises = [];
    for (const inst of instances.values()) {
        startPromises.push((async () => {
            try {
                await inst.wipeOrders();
                await inst.start();
            } catch (e) {
                log.error(inst.targetSymbol, `Initial start sequence failed: ${e.message}`);
            }
        })());
    }
    await Promise.allSettled(startPromises);

    globalMasterLoop();
    setInterval(syncServerTime, 60 * 60 * 1000);
    setInterval(loadInstruments, 6 * 60 * 60 * 1000);
}

// Start the server and the bots. We run the server even in Jenkins so we can access the UI via SSH Tunnel.
setInterval(() => sseClients.forEach(c => c.write(`: keepalive\n\n`)), 15000);

const UI_PORT = process.env.UI_PORT || 3000;
server.listen(UI_PORT, async () => {
    log.success('SYSTEM', '===========================================================');
    log.success('SYSTEM', 'Replicator Active.');
    log.success('SYSTEM', `UI is available on port ${UI_PORT}.`);
    log.success('SYSTEM', '===========================================================');

    
    startBots().catch(err => {
        log.critical('SYSTEM', `A fatal error occurred during bot startup: ${err.message}`);
        process.exit(1);
    });
});


process.on('SIGINT', async () => {
    log.warn('SYSTEM', 'Termination signal caught. Stopping all engines...');
    for (const inst of instances.values()) {
        await inst.stop();
    }
    process.exit(0);
});

// ==========================================
// 7. UI Render
// ==========================================
function getHtmlUI() {
    return require('fs').readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
}