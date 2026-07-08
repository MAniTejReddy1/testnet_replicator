const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const uuidv4 = crypto.randomUUID ? crypto.randomUUID.bind(crypto) : function() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = crypto.randomBytes(1)[0] % 16;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
};
const WebSocket = require('ws');
const { AsyncLocalStorage } = require('async_hooks');
const tierContextStore = new AsyncLocalStorage();
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
    PRODUCTION: {
        'user1': {
            label: 'User 1',
            listenKey: process.env.USER1_LISTEN_KEY || "",
            key: process.env.USER1_KEY || '3cef4baed18692062ff1b99e71adbce1e8558c58ad0113b9',
            secret: process.env.USER1_SECRET || '754688e515c77a50005dac4ff650e3203311467dbc1a4858bb7e84c5463e7508',
            email: 'mani.reddy+t7ui62u3@coindcx.com',
            password: 'Test@123',
            bearer_token: 'D4-rDgtolGWPsATr9OuMOOfxcc6cvt9_-y5Wt47MBKk'
        },
        'user2': {
            label: 'User 2',
            listenKey: process.env.USER2_LISTEN_KEY || "",
            key: process.env.USER2_KEY || '4874d42c94d55e25695cb853dd1cc6de88db4eba327424ba',
            secret: process.env.USER2_SECRET || 'b8e9788d189989c28dfb1136fad7cbd1f095ecb24fe1ff669e45e0997fd13fd2',
            email: 'mani.reddy+9jcgxr6r@coindcx.com',
            password: 'Test@123',
            bearer_token: 'QhsHol9LMDbCx00KwHMvD2V922mjA0sa7F3_AACF2Ws'
        }
    },
    JAPAN: {
        'user1': {
            label: 'User 1',
            listenKey: process.env.USER1_LISTEN_KEY || "",
            key: process.env.USER1_KEY || 'c8bc870189341e8f7e9c19dabc99d06b632e699e8a0b2422',
            secret: process.env.USER1_SECRET || '937609fba93cdf8ed7e5a865a5be4781d6853cdf4e01eab3ebb804c23e4c21ef',
            email: 'mani.reddy+wuqiibu2@coindcx.com',
            password: 'Test@123',
            bearer_token: 'srqqapCc-LLqjSXCtr4UT1BU6INswoAflh-ZQLhnAb8'
        },
        'user2': {
            label: 'User 2',
            listenKey: process.env.USER2_LISTEN_KEY || "",
            key: process.env.USER2_KEY || '8a00e70cbaed5893451a8adf944ab8674bb8d10ce8813ebb',
            secret: process.env.USER2_SECRET || '2368a0f0a44c342ede6f829d782fee0ba26a419de865451eb9e3be6a17af002f',
            email: 'mani.reddy+0il4qjod@coindcx.com',
            password: 'Test@123',
            bearer_token: 'v9l1XJMPJU8mYjQRPKIPrMW2DuzGfyEdacDUD5GVFZI'
        }
    },
    STAGING: {}
};

let globalRoles = {
    PRODUCTION: { makerId: 'user1', takerId: 'user2' },
    JAPAN: { makerId: 'user1', takerId: 'user2' },
    STAGING: { makerId: '', takerId: '' }
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

// Global Portfolios (Account level per tier)
const TIER_URLS = {
    PRODUCTION: {
        HPO: "https://testnet-futures-hpo.dcxstage.com",
        MDS_READ: "https://testnet-futures-mds-read.dcxstage.com",
        PUBLIC_MDN: "https://testnet-public-mdn.dcxstage.com",
        ONBOARDING: "https://testnet-api.dcxstage.com",
        RAILS: "https://testnet-rails-api.dcxstage.com",
        WS_GATEWAY: "wss://testnet-futures-socket-gateway.dcxstage.com"
    },
    JAPAN: {
        HPO: "https://testnet-exchange-hpo.dcxstage.com",
        MDS_READ: "https://testnet-exchange-mds-read.dcxstage.com",
        PUBLIC_MDN: "https://testnet-exchange-public-mdn.dcxstage.com",
        ONBOARDING: "https://testnet-exchange-api.dcxstage.com",
        RAILS: "https://testnet-exchange-rails-api.dcxstage.com",
        WS_GATEWAY: "wss://testnet-exchange-futures-socket-gateway.dcxstage.com"
    },
    STAGING: {
        HPO: "https://staging-exchange-futures-hpo.dcxstage.com",
        MDS_READ: "https://staging-exchange-futures-mds-read.dcxstage.com",
        PUBLIC_MDN: "https://staging-exchange-public-mdn.dcxstage.com",
        ONBOARDING: "https://staging-exchange-api.dcxstage.com",
        RAILS: "https://staging-exchange-rails-api.dcxstage.com",
        WS_GATEWAY: "wss://testnet-staging-futures-socket-gateway.dcxstage.com"
    }
};

let globalActiveTier = (process.env.ACTIVE_TIER || 'PRODUCTION').toUpperCase();

if (globalActiveTier && (globalActiveTier === 'JAPAN' || globalActiveTier === 'STAGING')) {
    if (process.env.USER1_KEY || process.env.USER2_KEY) {
        globalUsers[globalActiveTier] = {
            'user1': {
                label: 'User 1',
                listenKey: process.env.USER1_LISTEN_KEY || "",
                key: process.env.USER1_KEY || '',
                secret: process.env.USER1_SECRET || '',
                email: process.env.USER1_EMAIL || 'mani.reddy@coindcx.com',
                password: 'Test@123'
            },
            'user2': {
                label: 'User 2',
                listenKey: process.env.USER2_LISTEN_KEY || "",
                key: process.env.USER2_KEY || '',
                secret: process.env.USER2_SECRET || '',
                email: process.env.USER2_EMAIL || 'mani.reddy@coindcx.com',
                password: 'Test@123'
            }
        };
        globalRoles[globalActiveTier] = { makerId: 'user1', takerId: 'user2' };
    }
}

const portfolios = {
    PRODUCTION: {
        user1: { walletBalance: "0.00", availableBalance: "0.00", unrealizedProfit: "0.00", positions: [], openOrdersCount: 0, error: null },
        user2: { walletBalance: "0.00", availableBalance: "0.00", unrealizedProfit: "0.00", positions: [], openOrdersCount: 0, error: null }
    },
    JAPAN: {
        user1: { walletBalance: "0.00", availableBalance: "0.00", unrealizedProfit: "0.00", positions: [], openOrdersCount: 0, error: null },
        user2: { walletBalance: "0.00", availableBalance: "0.00", unrealizedProfit: "0.00", positions: [], openOrdersCount: 0, error: null }
    },
    STAGING: {
        user1: { walletBalance: "0.00", availableBalance: "0.00", unrealizedProfit: "0.00", positions: [], openOrdersCount: 0, error: null },
        user2: { walletBalance: "0.00", availableBalance: "0.00", unrealizedProfit: "0.00", positions: [], openOrdersCount: 0, error: null }
    }
};

let user1Portfolio = portfolios[globalActiveTier] ? portfolios[globalActiveTier].user1 : portfolios.PRODUCTION.user1;
let user2Portfolio = portfolios[globalActiveTier] ? portfolios[globalActiveTier].user2 : portfolios.PRODUCTION.user2;
let lastPortfolioSyncTime = 0;
const PORTFOLIO_SYNC_INTERVAL_MS = 30000;

// Instrument Data Map (Dynamically loaded, keyed by tier, then symbol)
const instrumentsMap = {
    PRODUCTION: {},
    JAPAN: {},
    STAGING: {}
};
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

function pushLog(level, sym, msg, meta = null, tier = null) {
    if (!tier) {
        tier = tierContextStore.getStore();
    }
    if (!tier && sym && sym !== 'SYSTEM') {
        for (const t of ['PRODUCTION', 'JAPAN', 'STAGING']) {
            const inst = instances[t] && instances[t].get(sym);
            if (inst) { tier = t; break; }
        }
    }
    if (!tier) tier = globalActiveTier;
    terminalLogs.push({ time: getISTTimeString(), level, sym, msg, ts: Date.now(), meta, tier });
    if (terminalLogs.length > 200) terminalLogs.shift();
}

function pushEvent(level, sym, msg, meta = null, cat = 'general', tier = null) {
    if (!tier) {
        tier = tierContextStore.getStore();
    }
    if (!tier && sym && sym !== 'SYSTEM') {
        for (const t of ['PRODUCTION', 'JAPAN', 'STAGING']) {
            const inst = instances[t] && instances[t].get(sym);
            if (inst) { tier = t; break; }
        }
    }
    if (!tier) tier = globalActiveTier;
    let cleanMeta = meta;
    if (['depth', 'trade', 'ticker'].includes(cat)) {
        cleanMeta = null;
    }
    terminalEvents.push({ time: getISTTimeString(), level, sym, msg, ts: Date.now(), meta: cleanMeta, cat, tier });
    if (terminalEvents.length > 2000) terminalEvents.shift();
}

const log = {
    info:     (sym, msg, meta, tier) => { console.log(`[\x1b[34mINFO\x1b[0m][${sym}] ${msg}`); pushLog('INFO', sym, msg, meta, tier); },
    success:  (sym, msg, meta, tier) => { console.log(`[\x1b[32mSUCCESS\x1b[0m][${sym}] ${msg}`); pushLog('SUCCESS', sym, msg, meta, tier); },
    error:    (sym, msg, meta, tier) => { console.error(`[\x1b[31mERROR\x1b[0m][${sym}] ${msg}`); pushLog('ERROR', sym, msg, meta, tier); },
    warn:     (sym, msg, meta, tier) => { console.log(`[\x1b[33mWARN\x1b[0m][${sym}] ${msg}`); pushLog('WARN', sym, msg, meta, tier); },
    critical: (sym, msg, meta, tier) => { console.log(`[\x1b[41m\x1b[37mCRITICAL\x1b[0m][${sym}] ${msg}`); pushLog('CRITICAL', sym, msg, meta, tier); },
    debug:    (sym, msg, meta, tier) => { if (DEBUG) { console.log(`[\x1b[35mDEBUG\x1b[0m][${sym}] ${msg}`); pushLog('DEBUG', sym, msg, meta, tier); } }
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

async function sendSignedRequest(url, method, payload, userConfig, timeoutMs = 50000, tier = null) {
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
        log.info(uLabel, `[${method.toUpperCase()}] ${shortUrl} | Status: ${res.status} | Latency: ${latencyMs}ms`, meta, tier);

        if (!res.ok || DEBUG) log.debug('REST-API', `[${method.toUpperCase()}] ${finalUrl} | Status: ${res.status} | Body: ${text} | Latency: ${latencyMs}ms`, null, tier);

        return { ok: res.ok, status: res.status, data, latencyMs };
    } catch (err) {
        clearTimeout(timeoutId);
        const latencyMs = Date.now() - startTime;
        const isTimeout = err.name === 'AbortError' || err.message.includes('aborted');
        const shortUrl = new URL(finalUrl).pathname;
        if (isTimeout) log.error(uLabel, `[TIMEOUT] ${method.toUpperCase()} to ${shortUrl} timed out after ${latencyMs}ms.`, null, tier);
        else log.error(uLabel, `[ERROR] ${method.toUpperCase()} to ${shortUrl} failed after ${latencyMs}ms: ${err.message}`, null, tier);
        return { ok: false, status: isTimeout ? 408 : 500, error: isTimeout ? 'Request Timeout' : err.message, latencyMs };
    }
}

const cachedAuthTokens = new Map();
const activeSeedPromises = new Map();

// Seed balance helper — logs in with email/password to get bearer token, then calls seed_balance
async function seedBalance(userCreds, tier = 'PRODUCTION') {
    if (!userCreds || !userCreds.email) return false;
    const cacheKey = `${userCreds.email}_${tier}`;
    
    // If there is already an active seeding request for this user on this tier, wait for it / return it
    if (activeSeedPromises.has(cacheKey)) {
        log.info('SYSTEM', `[SEED][${tier}] Seeding already in progress for ${userCreds.email}. Reusing existing promise.`);
        return activeSeedPromises.get(cacheKey);
    }
    
    const promise = (async () => {
        try {
            return await runSeedBalance(userCreds, tier);
        } finally {
            activeSeedPromises.delete(cacheKey);
        }
    })();
    
    activeSeedPromises.set(cacheKey, promise);
    return promise;
}

async function runSeedBalance(userCreds, tier) {
    const urls = TIER_URLS[tier] || TIER_URLS.PRODUCTION;
    const AUTH_URL = `${urls.ONBOARDING}/api/v3/authenticate`;
    const SEED_URL = `${urls.HPO}/api/v1/derivatives/futures/wallets/seed_balance`;
    const cacheKey = `${userCreds.email}_${tier}`;

    try {
        emitOrderEvent('seed:triggered', { user: userCreds.email, tier });
        if (!userCreds.email || !userCreds.password) {
            log.warn('SYSTEM', `[SEED][${tier}] No email/password configured for this user — cannot seed balance.`);
            emitOrderEvent('seed:failed', { user: userCreds.email, tier, error: 'No email/password configured' });
            return false;
        }

        let bearerToken = null;
        const cached = cachedAuthTokens.get(cacheKey);
        // Reuse cached token if it's less than 5 minutes old
        if (cached && (Date.now() - cached.ts < 5 * 60 * 1000)) {
            bearerToken = cached.token;
            log.info('SYSTEM', `[SEED][${tier}] Reusing cached auth token for ${userCreds.email}`);
        } else {
            // Step 1: Login to get bearer token
            log.info('SYSTEM', `[SEED][${tier}] Authenticating ` + userCreds.email + ' to get bearer token...');
            const loginRes = await fetch(AUTH_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'User-Agent': 'PostmanRuntime/7.32.3' },
                body: JSON.stringify({ email: userCreds.email, password: userCreds.password, pe: false, piie: false })
            });
            const loginData = await loginRes.json();
            bearerToken = loginData.auth_token || loginData.token;

            if (!bearerToken) {
                log.warn('SYSTEM', `[SEED][${tier}] Login failed — no auth_token in response: ` + JSON.stringify(loginData));
                emitOrderEvent('seed:failed', { user: userCreds.email, tier, error: 'Login failed: ' + JSON.stringify(loginData) });
                return false;
            }
            log.success('SYSTEM', `[SEED][${tier}] Login successful. Got bearer token.`);
            cachedAuthTokens.set(cacheKey, { token: bearerToken, ts: Date.now() });
        }

        // Step 2: Call seed_balance with bearer token
        log.info('SYSTEM', `[SEED][${tier}] Calling seed_balance...`);
        const seedRes = await fetch(SEED_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': bearerToken,
                'User-Agent': 'PostmanRuntime/7.32.3'
            },
            body: JSON.stringify({ currency_short_name: 'USDT' })
        });
        
        // Handle token expiration/invalid token (401/403) by clearing cache and retrying once
        if ((seedRes.status === 401 || seedRes.status === 403) && cached) {
            log.warn('SYSTEM', `[SEED][${tier}] Cached token rejected with status ${seedRes.status}. Clearing cache and retrying authentication...`);
            cachedAuthTokens.delete(cacheKey);
            return runSeedBalance(userCreds, tier); // Recursive retry with cleared cache
        }
        
        const seedData = await seedRes.json().catch(function() { return {}; });

        if (seedRes.ok || seedRes.status < 400) {
            log.success('SYSTEM', `[SEED][${tier}] seed_balance succeeded — wallet topped up.`);
            emitOrderEvent('seed:success', { user: userCreds.email, tier });
            return true;
        }
        log.warn('SYSTEM', `[SEED][${tier}] seed_balance returned non-OK [` + seedRes.status + ']: ' + JSON.stringify(seedData));
        emitOrderEvent('seed:failed', { user: userCreds.email, tier, error: JSON.stringify(seedData) });
        return false;
    } catch (err) {
        log.error('SYSTEM', `[SEED][${tier}] seed_balance threw: ` + err.message);
        emitOrderEvent('seed:failed', { user: userCreds.email, tier, error: err.message });
        return false;
    }
}

async function syncServerTime() {
    const urls = [
        `https://fapi.binance.com/fapi/v1/time`,
        `https://api.binance.com/api/v3/time`,
        `https://testnet-futures-hpo.dcxstage.com/fapi/v1/time`,
        `https://testnet-exchange-hpo.dcxstage.com/fapi/v1/time`,
        `https://staging-exchange-futures-hpo.dcxstage.com/fapi/v1/time`
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

async function loadInstruments(tier = 'PRODUCTION') {
    const urls = TIER_URLS[tier] || TIER_URLS.PRODUCTION;
    const hpoBase = urls.HPO;
    try {
        log.info('SYSTEM', `[${tier}] Fetching Instrument parameters and Exchange Info...`);
        
        // Fetch custom futures data
        const resData = await fetch(`${hpoBase}/api/v1/derivatives/futures/data`, {
            headers: { 'X-app-version': '6.56.0002' }
        });
        const data = await resData.json();

        if (!instrumentsMap[tier]) {
            instrumentsMap[tier] = {};
        }

        if (data && data.instruments) {
            data.instruments.forEach(inst => {
                const tick = parseFloat(inst.tick_size || inst.price_increment || 0.0001);
                const step = parseFloat(inst.quantity_increment || inst.min_trade_size || 1.0);
                const pricePrecision = (tick > 0 && isFinite(tick)) ? Math.max(0, -Math.round(Math.log10(tick))) : 4;
                const qtyPrecision   = (step > 0 && isFinite(step)) ? Math.max(0, -Math.round(Math.log10(step))) : 0;

                instrumentsMap[tier][inst.symbol.toUpperCase()] = {
                    tickSize: tick > 0 ? tick : 0.0001,
                    qtyStep:  step > 0 ? step : 1.0,
                    minQty:   parseFloat(inst.min_quantity || inst.min_trade_size || step || 1.0),
                    minNotional: 10.0, // Default fallback
                    pricePrecision,
                    qtyPrecision,
                    multiplierUp: 5,   // Default
                    multiplierDown: 5  // Default
                };
            });
        }

        // Fetch official FAPI exchangeInfo to get exact limits (PERCENT_PRICE and LOT_SIZE)
        const resInfo = await fetch(`${hpoBase}/fapi/v1/exchangeInfo`);
        const info = await resInfo.json();
        
        if (info && info.symbols) {
            info.symbols.forEach(sym => {
                const symbol = sym.symbol.toUpperCase();
                if (instrumentsMap[tier][symbol]) {
                    // Extract LOT_SIZE minQty
                    const lotSize = sym.filters.find(f => f.filterType === 'LOT_SIZE');
                    if (lotSize && lotSize.minQty) {
                        instrumentsMap[tier][symbol].minQty = parseFloat(lotSize.minQty);
                        instrumentsMap[tier][symbol].qtyStep = parseFloat(lotSize.stepSize);
                    }
                    // Extract PERCENT_PRICE multipliers
                    const pctPrice = sym.filters.find(f => f.filterType === 'PERCENT_PRICE');
                    if (pctPrice) {
                        instrumentsMap[tier][symbol].multiplierUp = parseFloat(pctPrice.multiplierUp);
                        instrumentsMap[tier][symbol].multiplierDown = parseFloat(pctPrice.multiplierDown);
                    }
                    // Extract MIN_NOTIONAL limit
                    const minNotional = sym.filters.find(f => f.filterType === 'MIN_NOTIONAL');
                    if (minNotional && minNotional.notional) {
                        instrumentsMap[tier][symbol].minNotional = parseFloat(minNotional.notional);
                    }
                }
            });
        }
        
        log.success('SYSTEM', `[${tier}] Loaded ${Object.keys(instrumentsMap[tier]).length} instruments with limit multipliers.`);
    } catch (e) { log.error('SYSTEM', `[${tier}] Instrument fetch failed: ${e.message}`); }
}

function calculateQty(sizeUsdt, priceStr, symbol, tier = 'PRODUCTION') {
    const price = parseFloat(priceStr);
    const tierMap = instrumentsMap[tier] || {};
    const inst = tierMap[symbol] || { qtyStep: 1.0, minQty: 1.0, qtyPrecision: 0, minNotional: 10.0 };

    if (isNaN(price) || price <= 0) return inst.minQty.toFixed(inst.qtyPrecision);

    const minNotional = inst.minNotional || 10.0;
    const finalSizeUsdt = Math.max(sizeUsdt, minNotional);

    let rawQty = finalSizeUsdt / price;
    const factor = 1 / inst.qtyStep;
    
    let qty;
    if (finalSizeUsdt === minNotional) {
        qty = Math.ceil(rawQty * factor) / factor;
    } else {
        qty = Math.round(rawQty * factor) / factor;
    }
    
    if (qty < inst.minQty) qty = inst.minQty;

    return qty.toFixed(inst.qtyPrecision);
}

function formatRawQty(rawQty, priceStr, symbol, tier = 'PRODUCTION') {
    const price = parseFloat(priceStr);
    const tierMap = instrumentsMap[tier] || {};
    const inst = tierMap[symbol] || { qtyStep: 1.0, minQty: 1.0, qtyPrecision: 0, minNotional: 10.0 };
    const factor = 1 / inst.qtyStep;
    let qty = Math.round(rawQty * factor) / factor;
    if (qty < inst.minQty) qty = inst.minQty;

    if (price > 0) {
        const minNotional = inst.minNotional || 10.0;
        const minQtyForNotional = minNotional / price;
        if (qty < minQtyForNotional) {
            qty = Math.ceil(minQtyForNotional * factor) / factor;
        }
    }

    return qty.toFixed(inst.qtyPrecision);
}

function formatPrice(priceStr, symbol, tier = 'PRODUCTION') {
    const tierMap = instrumentsMap[tier] || {};
    const inst = tierMap[symbol] || { pricePrecision: 4 };
    return parseFloat(priceStr).toFixed(inst.pricePrecision);
}

function applyBuffer(priceStr, side, bufferPct, symbol, tier = 'PRODUCTION') {
    if (!bufferPct || bufferPct === 0) return formatPrice(priceStr, symbol, tier);
    const raw = parseFloat(priceStr);
    const multiplier = side.toUpperCase() === 'BUY'
        ? (1 - bufferPct / 100)
        : (1 + bufferPct / 100);
    return formatPrice(String(raw * multiplier), symbol, tier);
}

async function autoGenerateNewUserAndAssign(role, tier) {
    const roleKey = role === 'TAKER' ? 'takerId' : 'makerId';
    const uniqueId = 'user_' + Math.random().toString(36).substring(2, 10);
    log.info('SYSTEM', `[RECOVERY][${tier}] Starting auto-generation of new user ${uniqueId} for role ${role}...`);
    
    try {
        const { execFile } = require('child_process');
        const execFileAsync = require('util').promisify(execFile);
        const targetUrls = TIER_URLS[tier] || TIER_URLS.PRODUCTION;
        
        const { stdout } = await execFileAsync('node', ['scripts/generate-single.js', uniqueId], {
            env: {
                ...process.env,
                API_BASE: targetUrls.ONBOARDING,
                RAILS_BASE: targetUrls.RAILS,
                FUTURES_URL: targetUrls.HPO
            }
        });
        
        const result = JSON.parse(stdout.trim());
        
        globalUsers[tier] = globalUsers[tier] || {};
        globalUsers[tier][uniqueId] = {
            label: uniqueId,
            key: result.key,
            secret: result.secret,
            email: result.email,
            password: 'Test@123',
            listenKey: ''
        };
        
        globalRoles[tier] = globalRoles[tier] || { makerId: '', takerId: '' };
        globalRoles[tier][roleKey] = uniqueId;
        lastPortfolioSyncTime = 0;
        
        log.success('SYSTEM', `[RECOVERY][${tier}] Successfully generated and assigned ${uniqueId} to ${roleKey}. Reconnecting private WS...`);
        
        // Reconnect WS for this tier
        reconnectAllInstancesPrivateWs(tier);
        
        // Authenticate to get listenKey and spawn the PrivateWsClient
        const listenKey = await authenticateAndGetListenKey(result.email, 'Test@123', tier);
        if (listenKey) {
            globalUsers[tier][uniqueId].listenKey = listenKey;
            if (globalUserWsClients[uniqueId]) {
                try { globalUserWsClients[uniqueId].close(); } catch(e) {}
            }
            globalUserWsClients[uniqueId] = new PrivateWsClient(
                listenKey,
                () => {},
                uniqueId,
                uniqueId,
                tier
            );
        }
        
        // Update WebSocket connections on all active instances of this tier
        const tierInstances = instances[tier] || new Map();
        for (const [, inst] of tierInstances.entries()) {
            if (role === 'MAKER' && inst.makerWs) {
                try { inst.makerWs.close(); } catch (e) {}
                if (listenKey) {
                    inst.makerWs = new PrivateWsClient(listenKey, inst.onMakerWsEvent.bind(inst), 'Maker', uniqueId, tier);
                }
            } else if (role === 'TAKER' && inst.takerWs) {
                try { inst.takerWs.close(); } catch (e) {}
                if (listenKey) {
                    inst.takerWs = new PrivateWsClient(listenKey, inst.onTakerWsEvent.bind(inst), 'Taker', uniqueId, tier);
                }
            }
        }
        
        broadcastToUI();

        // Sleep 120 seconds to allow testnet funds and API keys to fully propagate
        // (same wait applied in Jenkins Generate Test Credentials stage)
        log.info('SYSTEM', `[RECOVERY][${tier}] New user ${uniqueId} assigned. Sleeping 120s for funds and API keys to propagate before resuming trading...`);
        await new Promise(r => setTimeout(r, 120000));
        log.success('SYSTEM', `[RECOVERY][${tier}] Sleep complete. ${role} account is ready.`);

        return true;
    } catch (e) {
        log.error('SYSTEM', `[RECOVERY][${tier}] User generation for recovery failed: ${e.message}`);
        return false;
    }
}

// ==========================================
// Private WebSocket: Auth + Dual-Socket Architecture
// ==========================================
// DCX private WS requires:
//   1. Authenticate via POST /api/v3/authenticate → get JWT bearer token
//   2. Decode JWT payload → extract user_id = listenKey
//   3. Open TWO separate WS connections per user (gateway enforces 1 event/connection):
//      - wss://...?listenKey=<user_id>&events=ORDER_TRADE_UPDATE
//      - wss://...?listenKey=<user_id>&events=ACCOUNT_UPDATE

async function authenticateAndGetListenKey(email, password, tier = 'PRODUCTION') {
    try {
        const urls = TIER_URLS[tier] || TIER_URLS.PRODUCTION;
        const authUrl = `${urls.ONBOARDING}/api/v3/authenticate`;
        const body = JSON.stringify({ email, password, pe: false, piie: false });
        const res = await fetch(authUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/plain, */*',
                'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 10; GM1901 Build/QKQ1.190716.003)',
                'X-Adjust-Device-Id': '1911c181-d0bf-493f-8117-476017edffa0',
                'X-Source': 'trader_mode_android'
            },
            body
        });
        const data = await res.json();
        const token = data.token || data.access_token || data.auth_token;
        if (!token) {
            log.error('SYSTEM', `Auth failed for ${email}: No token in response. Keys: ${Object.keys(data).join(',')}`);
            return null;
        }
        // Decode JWT payload (Base64URL → JSON)
        const payloadB64 = token.split('.')[1];
        const payloadStr = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        const payload = JSON.parse(payloadStr);
        const userId = payload.user_id;
        if (!userId) {
            log.error('SYSTEM', `Auth succeeded for ${email} but JWT has no user_id. Payload keys: ${Object.keys(payload).join(',')}`);
            return null;
        }
        log.success('SYSTEM', `Auth succeeded for ${email} — listenKey (user_id): ${userId}`);
        return userId;
    } catch (e) {
        log.error('SYSTEM', `Auth error for ${email}: ${e.message}`);
        return null;
    }
}

// Global user data stream WebSocket clients (persists across instance restarts)
const globalUserWsClients = {};

async function fetchListenKeys() {
    log.info('SYSTEM', 'Authenticating users for private WebSocket streams...');
    const tierUsers = globalUsers[globalActiveTier] || {};
    for (const [userId, userConfig] of Object.entries(tierUsers)) {
        // If listen key already set (from env), use it directly
        if (userConfig.listenKey) {
            log.success('SYSTEM', `Listen key pre-configured for ${userConfig.label || userId} — connecting...`, null, globalActiveTier);
            if (!globalUserWsClients[userId]) {
                globalUserWsClients[userId] = new PrivateWsClient(
                    userConfig.listenKey,
                    () => {},
                    userConfig.label || userId,
                    userId,
                    globalActiveTier
                );
            }
            continue;
        }

        // Authenticate via email/password to get JWT → extract user_id as listenKey
        if (!userConfig.email || !userConfig.password) {
            log.warn('SYSTEM', `No email/password for ${userConfig.label || userId} — skipping private WS.`, null, globalActiveTier);
            continue;
        }

        const listenKey = await authenticateAndGetListenKey(userConfig.email, userConfig.password, globalActiveTier);
        if (listenKey) {
            userConfig.listenKey = listenKey;
            globalUserWsClients[userId] = new PrivateWsClient(
                listenKey,
                () => {},
                userConfig.label || userId,
                userId,
                globalActiveTier
            );
        } else {
            log.warn('SYSTEM', `Could not obtain listenKey for ${userConfig.label || userId} — attempting auto user recovery...`, null, globalActiveTier);
            const tierRoles = globalRoles[globalActiveTier] || { makerId: '', takerId: '' };
            if (tierRoles.makerId === userId) {
                await autoGenerateNewUserAndAssign('MAKER', globalActiveTier);
            } else if (tierRoles.takerId === userId) {
                await autoGenerateNewUserAndAssign('TAKER', globalActiveTier);
            }
        }
    }
}

async function reconnectGlobalUserWs() {
    log.info('SYSTEM', `Migrating global private WS streams to ${globalActiveTier}...`);
    for (const [userId, client] of Object.entries(globalUserWsClients)) {
        try {
            client.close();
        } catch(e) {}
        delete globalUserWsClients[userId];
    }
    await fetchListenKeys();
}


async function switchEnvironment(newTier) {
    const prevTier = globalActiveTier;
    if (prevTier === newTier) return;

    log.info('SYSTEM', `Switching global environment view from ${prevTier} to ${newTier}...`);

    // 1. Deactivate instances of the previous tier
    const prevInstances = instances[prevTier];
    if (prevInstances) {
        for (const inst of prevInstances.values()) {
            inst.tempPrevStatus = inst.status;
            await inst.stop().catch(e => log.error(inst.symbol, `Stop failed during env switch: ${e.message}`, null, prevTier));
            if (inst.pollingInterval) {
                clearInterval(inst.pollingInterval);
                inst.pollingInterval = null;
            }
        }
    }

    // 2. Change the global active tier
    globalActiveTier = newTier;

    // 3. Load instrument mapping if not loaded
    if (!instrumentsMap[newTier] || Object.keys(instrumentsMap[newTier]).length === 0) {
        await loadInstruments(newTier);
    }

    // 4. Activate/Resume instances of the new tier
    const newInstances = instances[newTier];
    if (newInstances) {
        for (const inst of newInstances.values()) {
            await inst.wipeOrders().catch(e => {});
            if (inst.tempPrevStatus === 'RUNNING') {
                await inst.start().catch(e => log.error(inst.symbol, `Start failed during env switch: ${e.message}`, null, newTier));
            } else {
                await inst.mountOnly().catch(e => log.error(inst.symbol, `Mount failed during env switch: ${e.message}`, null, newTier));
            }
        }
    }

    // 5. Reconnect global private WebSockets and sync portfolios for the new environment
    await reconnectGlobalUserWs();
    lastPortfolioSyncTime = 0;
    await syncAllPortfolios();
}


// Re-authenticate every 30 minutes to keep listen keys fresh
function startListenKeyKeepalive() {
    setInterval(async () => {
        const tierUsers = globalUsers[globalActiveTier] || {};
        for (const [userId, userConfig] of Object.entries(tierUsers)) {
            if (!userConfig.email || !userConfig.password) continue;
            try {
                const newKey = await authenticateAndGetListenKey(userConfig.email, userConfig.password, globalActiveTier);
                if (newKey && newKey !== userConfig.listenKey) {
                    log.info('SYSTEM', `Listen key refreshed for ${userConfig.label || userId}. Reconnecting...`, null, globalActiveTier);
                    userConfig.listenKey = newKey;
                    if (globalUserWsClients[userId]) {
                        globalUserWsClients[userId].close();
                    }
                    globalUserWsClients[userId] = new PrivateWsClient(
                        newKey,
                        () => {},
                        userConfig.label || userId,
                        userId,
                        globalActiveTier
                    );
                }
            } catch (e) { /* silently ignore refresh errors */ }
        }
    }, 30 * 60 * 1000);
}

// ==========================================
// 3. Replicator Engine Instance
// ==========================================

// DCX gateway enforces ONE event type per connection.
// We open TWO WebSocket connections per user:
//   1. ORDER_TRADE_UPDATE — order fills, status changes
//   2. ACCOUNT_UPDATE     — balance/position changes
const PRIVATE_WS_BASE = 'wss://testnet-futures-socket-gateway.dcxstage.com/private/ws';
const PRIVATE_WS_EVENTS = ['ORDER_TRADE_UPDATE', 'ACCOUNT_UPDATE'];

class PrivateWsClient {
    constructor(listenKey, onMessageCb, label, userId, tier = 'PRODUCTION') {
        this.listenKey = listenKey;
        this.onMessageCb = onMessageCb;
        this.label = label;
        this.userId = userId;    // key into globalUsers/globalPortfolios
        this.tier = tier;
        this.sockets = {};       // keyed by event type
        this.pingIntervals = {};
        this.reconnectTimers = {};
        if (this.listenKey) {
            PRIVATE_WS_EVENTS.forEach(evt => this.connectStream(evt));
        }
    }

    connectStream(eventType) {
        if (this.reconnectTimers[eventType]) {
            clearTimeout(this.reconnectTimers[eventType]);
            this.reconnectTimers[eventType] = null;
        }
        if (this.sockets[eventType]) {
            try { this.sockets[eventType].close(); } catch (e) {}
        }

        const base = (TIER_URLS[this.tier] || TIER_URLS.PRODUCTION).WS_GATEWAY;
        const url = `${base}/private/ws?listenKey=${this.listenKey}&events=${eventType}`;
        log.info('SYSTEM', `Connecting ${this.label} [${eventType}] → ${url.replace(this.listenKey, this.listenKey.substring(0, 8) + '...')}`, null, this.tier);
        const ws = new WebSocket(url);
        this.sockets[eventType] = ws;

        ws.on('open', () => {
            log.success('SYSTEM', `${this.label} [${eventType}] connected.`, null, this.tier);
            pushEvent('SUCCESS', this.label, `Private WS connected: ${eventType}`, { status: 'connected', event: eventType }, 'ws', this.tier);
            this.pingIntervals[eventType] = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) ws.ping();
            }, 30000);
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                const evtType = msg.e || eventType;

                if (evtType === 'ORDER_TRADE_UPDATE') {
                    const o = msg.o || {};
                    const summary = `${o.S || ''} ${o.o || ''} ${o.s || ''} | Qty: ${o.q || '-'} | Price: ${o.p || '-'} | Status: ${o.X || '-'}`;
                    pushEvent('EVENT', this.label, `Order Update: ${summary}`, msg, 'order', this.tier);
                    globalOrderUpdateCounter++;
                    this.onMessageCb(o);

                    // Real-time portfolio update: push order data for frontend processing
                    if (this.userId && globalPortfolios[this.tier] && globalPortfolios[this.tier][this.userId]) {
                        const port = globalPortfolios[this.tier][this.userId];
                        if (!port._realtimeOrders) port._realtimeOrders = [];
                        port._realtimeOrders.push(o);
                        if (port._realtimeOrders.length > 100) {
                            port._realtimeOrders = port._realtimeOrders.slice(-100);
                        }
                    }
                    broadcastToUI();
                } else if (evtType === 'ACCOUNT_UPDATE') {
                    const a = msg.a || {};
                    const reason = a.m || 'unknown';

                    // Summary event
                    pushEvent('EVENT', this.label, `Account Update [${reason}] | Balances: ${(a.B || []).length} | Positions: ${(a.P || []).length}`, msg, 'account', this.tier);

                    // Individual balance events + real-time portfolio update
                    (a.B || []).forEach(b => {
                        const wallet = b.wb || '0';
                        const crossWallet = b.cw || '0';
                        const locked = b.lb || '0';
                        const balChange = b.bc || '0';
                        pushEvent('EVENT', this.label, `Balance | ${b.a || 'USDT'} | Wallet: ${wallet} | CrossWallet: ${crossWallet} | Locked: ${locked} | Change: ${balChange}`, b, 'balance', this.tier);

                        // Update globalPortfolios balance in real-time
                        if (this.userId && globalPortfolios[this.tier] && globalPortfolios[this.tier][this.userId] && (b.a === 'USDT' || !b.a)) {
                            const port = globalPortfolios[this.tier][this.userId];
                            port.walletBalance = parseFloat(wallet).toFixed(2);
                            port.availableBalance = (parseFloat(wallet) - parseFloat(locked)).toFixed(2);
                        }
                    });

                    // Individual position events + real-time portfolio update
                    (a.P || []).forEach(p => {
                        const amt = p.pa || '0';
                        const entry = p.ep || '0';
                        const upnl = p.up || '0';
                        const margin = p.mt || 'cross';
                        const side = parseFloat(amt) > 0 ? 'LONG' : parseFloat(amt) < 0 ? 'SHORT' : 'FLAT';
                        pushEvent('EVENT', this.label, `Position | ${p.s || '?'} | ${side} ${amt} @ ${entry} | uPnL: ${upnl} | ${margin} | IsolatedWallet: ${p.iw || '0'}`, p, 'position', this.tier);

                        // Update globalPortfolios positions in real-time
                        if (this.userId && globalPortfolios[this.tier] && globalPortfolios[this.tier][this.userId]) {
                            const port = globalPortfolios[this.tier][this.userId];
                            const positions = port.positions || [];
                            const posSymbol = p.s || '';
                            const posAmt = parseFloat(amt);
                            const idx = positions.findIndex(pos => pos.symbol === posSymbol);
                            
                            if (posAmt === 0) {
                                // Position closed — remove it
                                if (idx !== -1) positions.splice(idx, 1);
                            } else {
                                const inst = instrumentsMap[posSymbol] || { pricePrecision: 4, qtyPrecision: 3 };
                                const updatedPos = {
                                    symbol: posSymbol,
                                    side: posAmt > 0 ? 'LONG' : 'SHORT',
                                    size: Math.abs(posAmt).toFixed(inst.qtyPrecision),
                                    entryPrice: parseFloat(entry).toFixed(inst.pricePrecision),
                                    markPrice: idx !== -1 ? positions[idx].markPrice : parseFloat(entry).toFixed(inst.pricePrecision),
                                    unrealizedPnL: parseFloat(upnl).toFixed(2),
                                    leverage: idx !== -1 ? positions[idx].leverage : '5',
                                    liqPrice: idx !== -1 ? positions[idx].liqPrice : '0.00',
                                    margin: parseFloat(p.iw || 0).toFixed(2)
                                };
                                if (idx !== -1) positions[idx] = { ...positions[idx], ...updatedPos };
                                else positions.push(updatedPos);
                            }
                            port.positions = positions;

                            // Update unrealizedProfit total
                            const totalPnl = positions.reduce((sum, pos) => sum + parseFloat(pos.unrealizedPnL || 0), 0);
                            port.unrealizedProfit = totalPnl.toFixed(2);
                        }
                    });
                    broadcastToUI();
                } else if (evtType === 'listenKeyExpired') {
                    pushEvent('WARN', this.label, `Listen key expired on ${eventType} — reconnecting...`, msg, 'ws', this.tier);
                    ws.close();
                } else {
                    pushEvent('EVENT', this.label, `[${eventType}] ${evtType}`, msg, 'general', this.tier);
                }
            } catch (e) {
                log.error('SYSTEM', `Error parsing ${this.label} [${eventType}] WS: ${e.message}`, null, this.tier);
            }
        });

        ws.on('close', () => {
            log.warn('SYSTEM', `${this.label} [${eventType}] disconnected. Reconnecting in 5s...`, null, this.tier);
            pushEvent('WARN', this.label, `Private WS disconnected: ${eventType}`, { status: 'disconnected', event: eventType }, 'ws', this.tier);
            clearInterval(this.pingIntervals[eventType]);
            this.reconnectTimers[eventType] = setTimeout(() => this.connectStream(eventType), 5000);
        });

        ws.on('error', (err) => {
            log.error('SYSTEM', `${this.label} [${eventType}] WS error: ${err.message}`, null, this.tier);
            pushEvent('ERROR', this.label, `Private WS error [${eventType}]: ${err.message}`, { error: err.message, event: eventType }, 'ws', this.tier);
        });
    }

    close() {
        PRIVATE_WS_EVENTS.forEach(evt => {
            clearInterval(this.pingIntervals[evt]);
            clearTimeout(this.reconnectTimers[evt]);
            if (this.sockets[evt]) {
                try {
                    const sock = this.sockets[evt];
                    sock.removeAllListeners('close');
                    sock.removeAllListeners('message');
                    sock.removeAllListeners('error');
                    sock.on('error', () => {}); // Catch-all to prevent unhandled 'error' event crashes
                    sock.close();
                } catch (e) {}
                this.sockets[evt] = null;
            }
        });
    }
}

function reconnectAllInstancesPrivateWs(tier) {
    const tierInstances = instances[tier] || new Map();
    for (const [, inst] of tierInstances.entries()) {
        inst.reconnectPrivateWs();
    }
}

class ReplicatorInstance {
    constructor(marketConfig) {
        this.tier = (marketConfig.tier || 'PRODUCTION').toUpperCase();
        if (!TIER_URLS[this.tier]) this.tier = 'PRODUCTION';

        this.sourceSymbol = marketConfig.sourceSymbol.toUpperCase();
        this.targetSymbol = (marketConfig.targetSymbol || marketConfig.sourceSymbol).toUpperCase();
        
        this.symbol = this.targetSymbol; 
        this.status = 'STOPPED';

        this.minSize            = marketConfig.minSize !== undefined ? marketConfig.minSize : 10;
        this.maxSize            = marketConfig.maxSize !== undefined ? marketConfig.maxSize : 50000;
        this.takerSize          = marketConfig.takerSize          || 10;
        this.makerUseRawQty     = marketConfig.makerUseRawQty === true;
        this.takerUseRawQty     = marketConfig.takerUseRawQty === true;
        this.depthLevels        = marketConfig.depthLevels        || 20;
        this.qtyChangeTolerance = marketConfig.qtyChangeTolerance || 0.25;
        this.enableTradeSync    = marketConfig.enableTradeSync !== false;
        this.newUserFlow        = marketConfig.newUserFlow === true;
        this.bufferPct          = marketConfig.bufferPct          || 0;
        this.cancelOnStop       = marketConfig.cancelOnStop === true;
        this.tradeDelayMs       = marketConfig.tradeDelayMs       || 0;
        this.mountOnlyState     = marketConfig.mountOnly === true;
        
        this.inFlightEdits      = new Set();

        this.binanceDepth  = { bids: [], asks: [] };
        this.testnetDepth  = { bids: [], asks: [] };
        this.restingBids   = [];    
        this.restingAsks   = [];
        this.syncedTrades  = [];

        this.tradeQueue          = [];
        this.priceLocks          = new Set();
        this.ghostCancelQueue    = new Set();
        this.tradeSyncMakerOrders = new Set();
        this.inFlightCancels     = new Set();
        this.cancelRetries       = new Map();
        this.inFlightTakerOrders = new Map();

        this.isCrossing         = false;
        this.isSyncingDelta     = false;
        this.isCancellingGhosts = false;
        this.isAligningLtp      = false;
        this.isSyncingGrid      = false;
        this.isReducingPositions = false;
        this.reductionPromise    = null;

        this.wsBinanceDepth  = null;
        this.wsBinanceTrades = null;
        this.wsTestnet       = null;
        this.wsTestnetTicker = null;
        this.testnetPingInterval = null;
        this.wsBinanceTicker = null;
        this.binance24h = { high: 0, low: 0, volume: 0, priceChangePercent: 0 };
        this.stage24h = { high: 0, low: 0, volume: 0, priceChangePercent: 0 };
        this.binanceFundingRate = null;
        this.stageFundingRate   = null;
        this.binanceIndexPrice  = null;
        this.testnetIndexPrice  = null;

        this.testnetLatency    = 0;
        this.binanceLatency    = 0;
        this.binanceLtp        = "0.0000";
        this.testnetMarkPrice  = 0;
        this.binanceMarkPrice  = 0;
        this.wsTestnetMarkPrice = null;
        this.wsBinanceMarkPrice = null;
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

        const tierUsers = globalUsers[this.tier] || {};
        const tierRoles = globalRoles[this.tier] || { makerId: '', takerId: '' };
        
        const mId = tierRoles.makerId;
        const mUser = mId ? tierUsers[mId] : null;
        if (mUser) {
            this.makerWs = new PrivateWsClient(mUser.listenKey, this.onMakerWsEvent.bind(this), 'Maker', mId, this.tier);
        } else {
            this.makerWs = null;
        }

        const tId = tierRoles.takerId;
        const tUser = tId ? tierUsers[tId] : null;
        if (tUser) {
            this.takerWs = new PrivateWsClient(tUser.listenKey, this.onTakerWsEvent.bind(this), 'Taker', tId, this.tier);
        } else {
            this.takerWs = null;
        }
    }

    reconnectPrivateWs() {
        if (this.makerWs) {
            try { this.makerWs.close(); } catch(e) {}
            this.makerWs = null;
        }
        if (this.takerWs) {
            try { this.takerWs.close(); } catch(e) {}
            this.takerWs = null;
        }

        const tierUsers = globalUsers[this.tier] || {};
        const tierRoles = globalRoles[this.tier] || { makerId: '', takerId: '' };
        
        const mId = tierRoles.makerId;
        const mUser = mId ? tierUsers[mId] : null;
        if (mUser) {
            this.makerWs = new PrivateWsClient(mUser.listenKey, this.onMakerWsEvent.bind(this), 'Maker', mId, this.tier);
        }

        const tId = tierRoles.takerId;
        const tUser = tId ? tierUsers[tId] : null;
        if (tUser) {
            this.takerWs = new PrivateWsClient(tUser.listenKey, this.onTakerWsEvent.bind(this), 'Taker', tId, this.tier);
        }
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
                id: uuidv4(),
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

    async placeOrder(side, qty, price = null, orderType = 'LIMIT', isTaker = false, clientOrderId = null, _isRetry = false, options = {}) {
        const tierUsers = globalUsers[this.tier] || {};
        const tierRoles = globalRoles[this.tier] || { makerId: '', takerId: '' };
        const userCreds = isTaker ? tierUsers[tierRoles.takerId] : tierUsers[tierRoles.makerId];
        if (!userCreds) {
            throw new Error(`${isTaker ? 'Taker' : 'Maker'} credentials not configured on ${this.tier}`);
        }
        const userLabel = isTaker ? 'USER2_TAKER' : 'USER1_MAKER';
        const bufferedPrice = price ? applyBuffer(String(price), side, isTaker ? 0 : this.bufferPct, this.symbol, this.tier) : null;

        const payload = { symbol: this.symbol, side: side.toUpperCase(), quantity: String(qty) };
        if (options.reduceOnly) payload.reduceOnly = "true";
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

        const hpoBase = TIER_URLS[this.tier].HPO;
        log.debug(this.symbol, `[ORDER-PRE] ${userLabel} placing ${orderType} ${side} ${qty} @ ${bufferedPrice || 'MKT'} (raw: ${price}, buf: ${this.bufferPct}%)`);
        const res = await sendSignedRequest(`${hpoBase}/fapi/v1/order`, 'POST', payload, userCreds);

        if (res.status === 401) {
            this.handleAuthFailure(userLabel);
            if (!_isRetry) {
                log.warn(this.symbol, `[AUTH-FAIL] ${userLabel} got 401 — attempting auto user recovery...`);
                const roleName = isTaker ? 'TAKER' : 'MAKER';
                const recovered = await autoGenerateNewUserAndAssign(roleName, this.tier);
                if (recovered) {
                    log.success(this.symbol, `[AUTH-FAIL] ${userLabel} recovered with a new user. Retrying order...`);
                    return this.placeOrder(side, qty, price, orderType, isTaker, clientOrderId, true);
                }
            }
            return { success: false };
        }

        // Auto-retry on limit multiplier constraint: pause, align LTP, retry
        if (!res.ok && !_isRetry && res.data) {
            const msgStr = JSON.stringify(res.data).toLowerCase();
            const isLimitErr = res.data.code === -1013 || res.data.code === -2011 || res.data.code === -4003 || res.data.code === -4024 ||
                               msgStr.includes('percent_price') || msgStr.includes('price less than') || 
                               msgStr.includes('price greater than') || msgStr.includes('price limit') ||
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

        // Auto-recover on Open order limit exceeded (-1003)
        if (!res.ok && !_isRetry && res.data && res.data.code === -1003) {
            log.warn(this.symbol, `[LIMIT-EXCEEDED] ${userLabel} open order limit exceeded (-1003) — attempting auto user recovery...`);
            const roleName = isTaker ? 'TAKER' : 'MAKER';
            const recovered = await autoGenerateNewUserAndAssign(roleName, this.tier);
            if (recovered) {
                log.success(this.symbol, `[LIMIT-EXCEEDED] ${userLabel} recovered with a new user. Retrying order...`);
                return this.placeOrder(side, qty, price, orderType, isTaker, clientOrderId, true);
            } else {
                log.error(this.symbol, `[LIMIT-EXCEEDED] ${userLabel} recovery failed — cannot retry.`);
            }
        }

        // Auto-retry on insufficient funds: call seed_balance then retry once
        if (!res.ok && !_isRetry && res.data && res.data.code === -2018) {
            log.warn(this.symbol, `[SEED] ${userLabel} insufficient funds — calling seed_balance and retrying...`);
            const seeded = await seedBalance(userCreds, this.tier);
            if (seeded) {
                log.success(this.symbol, `[SEED] ${userLabel} balance topped up. Retrying order...`);
                return this.placeOrder(side, qty, price, orderType, isTaker, clientOrderId, true);
            } else {
                log.error(this.symbol, `[SEED] ${userLabel} seed_balance failed — attempting auto user recovery...`);
                const roleName = isTaker ? 'TAKER' : 'MAKER';
                const recovered = await autoGenerateNewUserAndAssign(roleName, this.tier);
                if (recovered) {
                    log.success(this.symbol, `[SEED] ${userLabel} recovered with a new user. Retrying order...`);
                    return this.placeOrder(side, qty, price, orderType, isTaker, clientOrderId, true);
                } else {
                    log.error(this.symbol, `[SEED] ${userLabel} recovery failed — cannot retry.`);
                }
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
        const bufferedPrice = applyBuffer(String(rawPrice), side, this.bufferPct, this.symbol, this.tier);
        const hpoBase = TIER_URLS[this.tier].HPO;

        const payload = {
            symbol:   this.symbol,
            orderId,
            side:     side.toUpperCase(),
            quantity: String(qty),
            price:    String(bufferedPrice)
        };

        const tierUsers = globalUsers[this.tier] || {};
        const tierRoles = globalRoles[this.tier] || { makerId: '', takerId: '' };
        const makerUser = tierUsers[tierRoles.makerId];
        if (!makerUser) {
            log.error(this.symbol, `[MODIFY-FAIL] Maker credentials not configured on ${this.tier}`);
            return false;
        }
        const res = await sendSignedRequest(`${hpoBase}/fapi/v1/order`, 'PUT', payload, makerUser, 50000, this.tier);

        if (res.status === 401) {
            this.handleAuthFailure('USER1_MAKER');
            log.warn(this.symbol, `[AUTH-FAIL] Maker got 401 on modify — attempting auto user recovery...`);
            const recovered = await autoGenerateNewUserAndAssign('MAKER', this.tier);
            if (recovered) {
                log.success(this.symbol, `[AUTH-FAIL] Maker recovered. Replaced with new user.`);
            }
            return { success: false, isTerminal: true };
        }

        if (!res.ok && res.data && res.data.code === -2010) {
            log.warn(this.symbol, `[POSITION-LIMIT] Maker modify hit max position (-2010). Invoking position reduction...`);
            this.reducePositions().catch(e => log.error(this.symbol, `[REDUCE-POS] Background reduction from modify failed: ${e.message}`));
            return { success: false, isTerminal: true };
        }

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
                log.debug(this.symbol, `[MODIFY-TERMINAL] ID: ${orderId} terminal (${res.data ? res.data.code : undefined}). Handled automatically.`);
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
        if (this.isReducingPositions) return;
        this.isAligningLtp = true;
        try {
            const inst = instrumentsMap[this.tier] && instrumentsMap[this.tier][this.symbol];
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

            const minQtyStr = calculateQty(0, '1', this.symbol, this.tier); // Gets minimum formatted qty

            // 3. Attempt Instant Market Alignment
            // Since syncGrid places one side of the book successfully before the other side fails,
            // the successful side is already resting on the book. We can instantly drag the LTP by placing a MARKET order against it.
            let marketRes = { success: false };
            const dragSide = failedSide || (targetPrice > testnetLtp ? 'BUY' : 'SELL');
            
            // Calculate sweep quantity from Stage orderbook asks/bids up to targetPrice to move market faster
            let sweepQty = 0;
            if (dragSide === 'BUY') {
                if (this.testnetDepth && Array.isArray(this.testnetDepth.asks)) {
                    for (const ask of this.testnetDepth.asks) {
                        const price = parseFloat(ask[0]);
                        const size = parseFloat(ask[1]);
                        if (price <= targetPrice) {
                            sweepQty += size;
                        }
                    }
                }
            } else {
                if (this.testnetDepth && Array.isArray(this.testnetDepth.bids)) {
                    for (const bid of this.testnetDepth.bids) {
                        const price = parseFloat(bid[0]);
                        const size = parseFloat(bid[1]);
                        if (price >= targetPrice) {
                            sweepQty += size;
                        }
                    }
                }
            }

            let qtyStr = minQtyStr;
            if (sweepQty > 0) {
                // Add a small 1% buffer to ensure full sweep, formatted safely according to quantity precision rules
                const formatted = calculateQty(0, String(sweepQty * 1.01), this.symbol, this.tier);
                if (parseFloat(formatted) > 0) {
                    qtyStr = formatted;
                }
            }

            const alignPriceStr = formatPrice(String(targetPrice), this.symbol, this.tier);
            log.info(this.symbol, `[ALIGN] Firing TAKER LIMIT_IOC ${dragSide} @ ${alignPriceStr} with sweep size ${qtyStr} (book sum: ${sweepQty}) to hit resting limits and drag LTP...`);
            marketRes = await this.placeOrder(dragSide, qtyStr, alignPriceStr, 'LIMIT_IOC', true, true);

            if (marketRes.success) {
                log.success(this.symbol, `[ALIGN] Successfully dragged LTP instantly via LIMIT_IOC order.`);
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

                let priceStr = formatPrice(String(nextPrice), this.symbol, this.tier);
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
                        
                        priceStr = formatPrice(String(nextPrice), this.symbol, this.tier);
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
        if (this.isReducingPositions) {
            log.info(this.symbol, `[POSITION-LIMIT] Reduction already in progress. Awaiting existing reduction...`);
            await this.reductionPromise;
            return;
        }

        this.isReducingPositions = true;
        this.reductionPromise = (async () => {
            log.warn(this.symbol, `[POSITION-LIMIT] Initiating position reduction for Maker and Taker...`);

            try {
                const hpoBase = TIER_URLS[this.tier].HPO;
                const tierUsers = globalUsers[this.tier] || {};
                const tierRoles = globalRoles[this.tier] || { makerId: '', takerId: '' };
                const makerUser = tierUsers[tierRoles.makerId];
                const takerUser = tierUsers[tierRoles.takerId];

                if (!makerUser || !takerUser) {
                    log.error(this.symbol, `[REDUCE-POS] Maker or Taker credentials not configured. Aborting.`);
                    return;
                }

                // Helper to get position info
                const getPosInfo = async (userCreds) => {
                    const posRes = await sendSignedRequest(`${hpoBase}/fapi/v2/positionRisk?symbol=${this.symbol}`, 'GET', null, userCreds);
                    if (!posRes.ok || !posRes.data) return null;
                    const positions = Array.isArray(posRes.data) ? posRes.data : [posRes.data];
                    return positions.find(p => p.symbol === this.symbol) || null;
                };

                // Step 1: Cancel open orders first to release margin and position quota
                log.info(this.symbol, `[REDUCE-POS] Wiping existing open orders before closing positions...`);
                await this.wipeOrders();

                // Step 2: Check actual position sizes
                let makerPos = await getPosInfo(makerUser);
                let takerPos = await getPosInfo(takerUser);

                const makerAmt = makerPos ? parseFloat(makerPos.positionAmt) : 0;
                const takerAmt = takerPos ? parseFloat(takerPos.positionAmt) : 0;

                log.info(this.symbol, `[REDUCE-POS] Active positions after wipe -> Maker: ${makerAmt}, Taker: ${takerAmt}`);

                if (makerAmt === 0 && takerAmt === 0) {
                    log.info(this.symbol, `[REDUCE-POS] No open positions to close.`);
                    return;
                }

                // Determine active orderbook price or fallback to LTP/Mark price
                let crossPriceStr = null;
                const bestBid = (this.testnetDepth && this.testnetDepth.bids && this.testnetDepth.bids.length > 0) ? this.testnetDepth.bids[0][0] : null;
                const bestAsk = (this.testnetDepth && this.testnetDepth.asks && this.testnetDepth.asks.length > 0) ? this.testnetDepth.asks[0][0] : null;

                if (makerAmt !== 0) {
                    const makerSide = makerAmt > 0 ? 'SELL' : 'BUY';
                    if (makerSide === 'SELL' && bestBid) {
                        crossPriceStr = formatPrice(String(bestBid), this.symbol, this.tier);
                    } else if (makerSide === 'BUY' && bestAsk) {
                        crossPriceStr = formatPrice(String(bestAsk), this.symbol, this.tier);
                    }
                }

                if (!crossPriceStr) {
                    // Fallback to current testnet LTP or binance LTP
                    const fallbackPrice = this.testnetDepth.bids.length ? this.testnetDepth.bids[0][0] : (this.binanceDepth.bids.length ? this.binanceDepth.bids[0][0] : null);
                    if (!fallbackPrice) {
                        log.error(this.symbol, `[REDUCE-POS] Cannot determine cross price. Aborting.`);
                        return;
                    }
                    crossPriceStr = formatPrice(String(fallbackPrice), this.symbol, this.tier);
                }

                let placedMaker = false;
                let placedTaker = false;

                // Step 3: Close positions completely using LIMIT and LIMIT_IOC cross-selling
                // Case 1: Both Maker and Taker have opposite non-zero positions -> Cross them
                if (makerAmt !== 0 && takerAmt !== 0 && (makerAmt > 0 !== takerAmt > 0)) {
                    const makerSide = makerAmt > 0 ? 'SELL' : 'BUY';
                    const takerSide = takerAmt > 0 ? 'SELL' : 'BUY';

                    const makerQtyStr = formatRawQty(Math.abs(makerAmt), crossPriceStr, this.symbol, this.tier);
                    const takerQtyStr = formatRawQty(Math.abs(takerAmt), crossPriceStr, this.symbol, this.tier);

                    log.info(this.symbol, `[REDUCE-POS] Cross-selling: Placing Maker LIMIT ${makerSide} for ${makerQtyStr} @ ${crossPriceStr} (best book price)...`);
                    const makerRes = await this.placeOrder(makerSide, makerQtyStr, crossPriceStr, 'LIMIT', false, null, true, { reduceOnly: true });
                    if (makerRes.success) placedMaker = true;

                    // Wait 200ms for Maker's order to rest on the book
                    await new Promise(r => setTimeout(r, 200));

                    log.info(this.symbol, `[REDUCE-POS] Cross-selling: Placing Taker LIMIT_IOC ${takerSide} for ${takerQtyStr} @ ${crossPriceStr}...`);
                    const takerRes = await this.placeOrder(takerSide, takerQtyStr, crossPriceStr, 'LIMIT_IOC', true, null, true, { reduceOnly: true });
                    if (takerRes.success) placedTaker = true;
                } else {
                    // Case 2: Asymmetric positions (only one user has positions)
                    if (makerAmt !== 0) {
                        const makerSide = makerAmt > 0 ? 'SELL' : 'BUY';
                        const makerQtyStr = formatRawQty(Math.abs(makerAmt), crossPriceStr, this.symbol, this.tier);
                        log.info(this.symbol, `[REDUCE-POS] Asymmetric Maker reduction: Placing LIMIT ${makerSide} for ${makerQtyStr} @ ${crossPriceStr}...`);
                        const makerRes = await this.placeOrder(makerSide, makerQtyStr, crossPriceStr, 'LIMIT', false, null, true, { reduceOnly: true });
                        if (makerRes.success) placedMaker = true;
                    }
                    if (takerAmt !== 0) {
                        const takerSide = takerAmt > 0 ? 'SELL' : 'BUY';
                        const takerQtyStr = formatRawQty(Math.abs(takerAmt), crossPriceStr, this.symbol, this.tier);
                        log.info(this.symbol, `[REDUCE-POS] Asymmetric Taker reduction: Placing LIMIT_IOC ${takerSide} for ${takerQtyStr} @ ${crossPriceStr}...`);
                        const takerRes = await this.placeOrder(takerSide, takerQtyStr, crossPriceStr, 'LIMIT_IOC', true, null, true, { reduceOnly: true });
                        if (takerRes.success) placedTaker = true;
                    }
                }

                // Step 4: Verification polling loop
                if (placedMaker || placedTaker) {
                    log.info(this.symbol, `[REDUCE-POS] Verification polling started...`);
                    let success = false;
                    for (let attempt = 1; attempt <= 10; attempt++) {
                        await new Promise(r => setTimeout(r, 500));
                        const mPos = await getPosInfo(makerUser);
                        const tPos = await getPosInfo(takerUser);

                        const mCur = mPos ? Math.abs(parseFloat(mPos.positionAmt)) : 0;
                        const tCur = tPos ? Math.abs(parseFloat(tPos.positionAmt)) : 0;

                        // Target is complete closure (0 or negligible amount)
                        const mClosed = mCur < 0.001;
                        const tClosed = tCur < 0.001;

                        log.debug(this.symbol, `[REDUCE-POS] Verification attempt ${attempt}/10 -> Maker: ${mCur}, Taker: ${tCur}`);

                        if (mClosed && tClosed) {
                            success = true;
                            log.success(this.symbol, `[REDUCE-POS] Verification success! Positions successfully closed.`);
                            break;
                        }
                    }
                    if (!success) {
                        log.warn(this.symbol, `[REDUCE-POS] Verification timeout. Resuming trading anyway.`);
                    }
                }
            } catch (err) {
                log.error(this.symbol, `[REDUCE-POS] Exception during position reduction: ${err.message}`);
            }
        })();

        try {
            await this.reductionPromise;
        } finally {
            this.isReducingPositions = false;
            this.reductionPromise = null;
        }
    }

    async cancelOrder(orderId, isTaker = false) {
        const tierUsers = globalUsers[this.tier] || {};
        const tierRoles = globalRoles[this.tier] || { makerId: '', takerId: '' };
        const userCreds = isTaker ? tierUsers[tierRoles.takerId] : tierUsers[tierRoles.makerId];
        const userLabel = isTaker ? 'USER2_TAKER' : 'USER1_MAKER';

        let price = null, side = null;
        if (!isTaker) {
            const b = this.restingBids.find(ro => ro && ro.orderId === orderId);
            const a = this.restingAsks.find(ro => ro && ro.orderId === orderId);
            if (b) { price = b.price; side = 'BUY'; }
            if (a) { price = a.price; side = 'SELL'; }
        }

        log.debug(this.symbol, `[CANCEL-PRE] ${userLabel} cancelling ID: ${orderId}`);
        const hpoBase = TIER_URLS[this.tier].HPO;
        const res = await sendSignedRequest(`${hpoBase}/fapi/v1/order`, 'DELETE', { symbol: this.symbol, orderId }, userCreds);

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
        if (this.status === 'PAUSED' || this.status === 'STOPPED') return; // Respect pause/stop
        if (this.isReducingPositions) return;
        const guardKey = 'isSyncing' + side;
        if (this[guardKey]) return;
        this[guardKey] = true;
        try {
            ScenarioEngine.tick(this.symbol, this.binanceLtp);
            const status = ScenarioEngine.getStatus(this.symbol);
            if (status && status.reconciliationRequired) {
                ScenarioEngine.clearReconciliationFlag(this.symbol);
                this.wipeOrders().catch(err => log.error(this.symbol, `Scenario reconciliation error: ${err.message}`));
            }
            const transformer = ScenarioEngine.getTransformer(this.symbol);

        const isBuy         = side === 'BUY';
        const restingOrders = isBuy ? this.restingBids : this.restingAsks;
        const tradeSync     = this.enableTradeSync;

        let skewedLevels = PriceTransformer.applyDepthSkew(sourceLevels, side, transformer);

        // Calculate current Stage price from the top of the book
        let stageLtp = parseFloat(this.binanceLtp || 0);
        if (this.testnetDepth && Array.isArray(this.testnetDepth.bids) && this.testnetDepth.bids.length > 0) {
            stageLtp = parseFloat(this.testnetDepth.bids[0][0]);
        } else if (this.testnetDepth && Array.isArray(this.testnetDepth.asks) && this.testnetDepth.asks.length > 0) {
            stageLtp = parseFloat(this.testnetDepth.asks[0][0]);
        }
        const binLtp = parseFloat(this.binanceLtp || 0);
        const driftPct = binLtp > 0 ? Math.abs(binLtp - stageLtp) / binLtp : 0;
        const isHugeDiff = driftPct > 0.01; // 1% price drift is considered a huge difference

        // Detect active scenario - if so, bypass min/max clamp and use raw orderbook qty
        const isScenarioActive = transformer && transformer.multiplier !== 1.0;
        const useRawQty = isScenarioActive || isHugeDiff || this.makerUseRawQty;

        const targets = skewedLevels.slice(0, this.depthLevels).map((lvl, index) => {
            let rawPrice  = lvl[0];
            rawPrice = PriceTransformer.applyPriceAxes(rawPrice, side, transformer, index);
            let qty;
            if (useRawQty) {
                // Use raw orderbook qty directly
                qty = formatRawQty(parseFloat(lvl[1]), rawPrice, this.symbol, this.tier);
            } else {
                const notional  = parseFloat(lvl[0]) * parseFloat(lvl[1]);
                const targetSz  = Math.max(this.minSize, Math.min(this.maxSize, notional));
                qty = calculateQty(targetSz, rawPrice, this.symbol, this.tier);
                qty = PriceTransformer.applyProfileSkew(qty, side, transformer, index);
            }
            return { rawPrice, price: formatPrice(rawPrice, this.symbol, this.tier), qty };
        });

        const activePool = [];
        const modifyBatch = [];
        const placeBatch = [];
        const cancelBatch = [];

        const maxLevels = Math.max(targets.length, restingOrders.length);
        for (let i = 0; i < maxLevels; i++) {
            const target = targets[i];
            const resting = restingOrders[i];

            if (target && resting) {
                const orderStatus = (resting.status || 'NEW').toUpperCase();
                
                if (this.priceLocks.has(target.price) || this.inFlightEdits.has(resting.orderId)) {
                    activePool.push(resting);
                    continue;
                }

                if (orderStatus === 'PARTIALLY_FILLED') {
                    activePool.push(resting);
                    continue;
                }

                const priceDiff = Math.abs(parseFloat(resting.price) - parseFloat(target.price));
                const qtyDiffPct = Math.abs(parseFloat(resting.qty) - parseFloat(target.qty)) / parseFloat(resting.qty);

                if (priceDiff > 0.00001 || qtyDiffPct > this.qtyChangeTolerance) {
                    this.inFlightEdits.add(resting.orderId);
                    modifyBatch.push((async () => {
                        const result = await this.modifyMaker(resting.orderId, side, target.rawPrice, target.qty);
                        this.inFlightEdits.delete(resting.orderId);
                        if (result.success) {
                            resting.price = target.price;
                            resting.qty = target.qty;
                            resting.status = 'NEW';
                            resting.createdAt = Date.now();
                            activePool.push(resting);
                        } else {
                            if (!result.isTerminal) activePool.push(resting);
                            const r = await this.placeOrder(side, target.qty, target.rawPrice, 'LIMIT');
                            if (r.success) {
                                activePool.push({
                                    orderId: r.orderId,
                                    price: target.price,
                                    qty: target.qty,
                                    status: 'NEW',
                                    createdAt: Date.now()
                                });
                            }
                        }
                    })());
                } else {
                    activePool.push(resting);
                }
            } else if (target) {
                if (this.priceLocks.has(target.price)) continue;
                
                placeBatch.push((async () => {
                    const r = await this.placeOrder(side, target.qty, target.rawPrice, 'LIMIT');
                    if (r.success) {
                        activePool.push({
                            orderId: r.orderId,
                            price: target.price,
                            qty: target.qty,
                            status: 'NEW',
                            createdAt: Date.now()
                        });
                    }
                })());
            } else if (resting) {
                const orderStatus = (resting.status || 'NEW').toUpperCase();
                if (this.inFlightEdits.has(resting.orderId) || !tradeSync || orderStatus === 'PARTIALLY_FILLED' || this.tradeSyncMakerOrders.has(resting.orderId)) {
                    activePool.push(resting);
                } else {
                    this.inFlightEdits.add(resting.orderId);
                    cancelBatch.push(this.cancelOrder(resting.orderId).finally(() => this.inFlightEdits.delete(resting.orderId)));
                }
            }
        }

        // Place-Before-Cancel: Place and modify new orders first
        await Promise.allSettled([...modifyBatch, ...placeBatch]);
        
        // Cancel excess orders in the background so book is never flat or empty
        if (cancelBatch.length > 0) {
            Promise.allSettled(cancelBatch).catch(err => {
                log.debug && log.debug(this.symbol, 'Background excess cancel failed: ' + err.message);
            });
        }
        
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
            const hpoBase = TIER_URLS[this.tier].HPO;
            const tierUsers = globalUsers[this.tier] || {};
            const tierRoles = globalRoles[this.tier] || { makerId: '', takerId: '' };
            const makerUser = tierUsers[tierRoles.makerId];
            if (!makerUser) {
                log.error(this.symbol, `[SYNC-FAIL] Maker credentials not configured on ${this.tier}`);
                return;
            }
            const openRes = await sendSignedRequest(`${hpoBase}/fapi/v1/openOrders`, 'GET', { symbol: this.symbol }, makerUser, 50000, this.tier);
            if (openRes.status === 401) { this.handleAuthFailure('USER1_MAKER'); return; }

            if (openRes.ok && Array.isArray(openRes.data)) {
                await this.refreshRestingStatuses(openRes.data);
                const exchangeIds = new Set(openRes.data.map(o => String(o.orderId || o.id)));
                const now = Date.now();
                const retain = (ro) => ro && (exchangeIds.has(String(ro.orderId)) || (now - (ro.createdAt || 0) < 5000));
                this.restingBids  = this.restingBids.filter(retain);
                this.restingAsks  = this.restingAsks.filter(retain);

                const localIds = new Set([...this.restingBids.map(ro => String(ro.orderId)), ...this.restingAsks.map(ro => String(ro.orderId))]);
                
                // Safety: Ghost detection runs continuously, ignoring in-flight edits and orders newer than 5 seconds
                const ghosts = openRes.data.filter(o => {
                    const id = String(o.orderId || o.id);
                    const orderTime = o.time || o.updateTime || now;
                    const age = now - orderTime;
                    return !localIds.has(id) && 
                           !this.inFlightEdits.has(id) && 
                           age > 5000;
                });
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
        
        ScenarioEngine.tick(this.symbol, this.binanceLtp);
        const status = ScenarioEngine.getStatus(this.symbol);
        if (status && status.reconciliationRequired) {
            ScenarioEngine.clearReconciliationFlag(this.symbol);
            this.wipeOrders().catch(err => log.error(this.symbol, `Scenario reconciliation error: ${err.message}`));
        }
        const transformer = ScenarioEngine.getTransformer(this.symbol);
        const transformedTradePrice = PriceTransformer.applyPriceAxes(trade.p, trade.m ? 'SELL' : 'BUY', transformer, 0);

        const pStr      = formatPrice(transformedTradePrice, this.symbol, this.tier);
        const remainingScenarioQty = ScenarioEngine.getRemainingQty(this.symbol);
        
        let makerQty;
        if (remainingScenarioQty !== null) {
            // Scenario CONDITION_SEEKING mode: use raw trade qty for quick market control
            if (remainingScenarioQty <= 0) return; // Freeze Taker if scenario condition is met
            const rawTradeQty = parseFloat(trade.q);
            makerQty = formatRawQty(Math.min(rawTradeQty, remainingScenarioQty), transformedTradePrice, this.symbol, this.tier);
        } else if (transformer.multiplier !== 1.0) {
            // Scenario DETERMINISTIC mode: use raw trade qty directly (no notional clamping)
            makerQty = formatRawQty(parseFloat(trade.q), transformedTradePrice, this.symbol, this.tier);
        } else if (this.makerUseRawQty) {
            // Maker uses raw trade qty directly
            makerQty = formatRawQty(parseFloat(trade.q), transformedTradePrice, this.symbol, this.tier);
        } else {
            // Normal mode: apply notional size clamp (minSize/maxSize) for maker
            const notional  = parseFloat(trade.q) * parseFloat(transformedTradePrice);
            const targetSz  = Math.max(this.minSize, Math.min(this.maxSize, notional));
            makerQty = calculateQty(targetSz, transformedTradePrice, this.symbol, this.tier);
        }

        // Taker size is determined from the takerSize configuration
        let takerQty;
        if (this.takerUseRawQty) {
            takerQty = formatRawQty(parseFloat(trade.q), transformedTradePrice, this.symbol, this.tier);
        } else {
            takerQty = calculateQty(this.takerSize, transformedTradePrice, this.symbol, this.tier);
            if (parseFloat(takerQty) <= 0) {
                // Fallback to min quantity if takerSize evaluates to 0 due to precision limits
                takerQty = calculateQty(0, '1', this.symbol, this.tier);
            }
        }

        const makerSide = trade.m ? 'BUY' : 'SELL';
        const takerSide = trade.m ? 'SELL' : 'BUY';

        // Determine if there's a resting maker order at this price BEFORE acquiring priceLock
        const restingPool     = makerSide === 'BUY' ? this.restingBids : this.restingAsks;
        const hasRestingMaker = restingPool.find(ro => ro && ro.price === pStr);
        let finalMakerId      = hasRestingMaker ? hasRestingMaker.orderId : null;

        this.priceLocks.add(pStr);
        log.info(this.symbol, `[TRADE-SYNC] Starting sync: makerSide=${makerSide}, makerQty=${makerQty}, takerQty=${takerQty}, price=${transformedTradePrice}, hasRestingMaker=${!!hasRestingMaker}`);
        try {
            if (!hasRestingMaker) {
                const makerRes = await this.placeOrder(makerSide, makerQty, transformedTradePrice, 'LIMIT');
                finalMakerId = makerRes.orderId;
                if (finalMakerId) {
                    this.tradeSyncMakerOrders.add(finalMakerId);
                }
                log.info(this.symbol, `[TRADE-SYNC-MAKER] Result success=${makerRes.success}, id=${finalMakerId}`);
                if (!makerRes.success) return; // If maker fails, we abort
            }

            if (this.tradeDelayMs > 0) await new Promise(r => setTimeout(r, this.tradeDelayMs));

            const clientOrderId = uuidv4();
            
            // Register in flight context immediately
            this.inFlightTakerOrders.set(clientOrderId, {
                makerOrderId: finalMakerId,
                limitPrice: pStr,
                expectedQty: String(takerQty),
                binanceQty: trade.q,
                ts: Date.now()
            });

            emitOrderEvent('order:fill_attempt', {
                symbol: this.symbol,
                makerOrderId: finalMakerId,
                takerOrderId: 'pending_ws',
                expectedQty: takerQty,
                price: transformedTradePrice
            });

            log.info(this.symbol, `[TRADE-SYNC-TAKER-PRE] Placing Taker side=${takerSide}, qty=${takerQty}, price=${transformedTradePrice}`);
            const takerRes = await this.placeOrder(takerSide, takerQty, transformedTradePrice, 'LIMIT_IOC', true, clientOrderId);
            log.info(this.symbol, `[TRADE-SYNC-TAKER-POST] Taker Result success=${takerRes.success}`);
            if (finalMakerId) {
                this.tradeSyncMakerOrders.delete(finalMakerId);
            }
            
            if (!takerRes.success) {
                // HTTP rejection (e.g. margin limit). Push failure immediately to UI
                this.inFlightTakerOrders.delete(clientOrderId);
                this.syncedTrades.unshift({
                    id: uuidv4(),
                    time: getISTTimeString(),
                    price: pStr,
                    avgPrice: null,
                    side: takerSide,
                    binanceQty: trade.q,
                    stageQty: String(takerQty),
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
                            const hpoBase = TIER_URLS[this.tier].HPO;
                            const tierUsers = globalUsers[this.tier] || {};
                            const tierRoles = globalRoles[this.tier] || { makerId: '', takerId: '' };
                            const takerUser = tierUsers[tierRoles.takerId];
                            if (takerUser) {
                                const checkRes = await sendSignedRequest(`${hpoBase}/fapi/v1/order`, 'GET', { symbol: this.symbol, orderId: takerRes.orderId }, takerUser, 50000, this.tier);
                                if (checkRes.ok && checkRes.data) {
                                    finalTakerRes = {
                                        ...takerRes,
                                        status: checkRes.data.status,
                                        executedQty: checkRes.data.executedQty,
                                        avgPrice: checkRes.data.avgPrice
                                    };
                                }
                            }
                        } catch(e) { log.debug && log.debug('SYSTEM', e.message); }
                    }

                    const executedQty = finalTakerRes.executedQty || String(takerQty);
                    this.inFlightTakerOrders.delete(clientOrderId);
                    this.syncedTrades.unshift({
                        id: uuidv4(),
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

            ScenarioEngine.reportExecution(this.symbol, takerQty);

        } finally { this.priceLocks.delete(pStr); }
    }

    async processTradeQueue() {
        if (manualOverride) return;
        if (this.status === 'PAUSED') return; // PAUSED: don't process taker trades
        if (this.isReducingPositions) return;
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
            try {
                const data = JSON.parse(raw.toString());
                const bids = data.bids || data.b;
                const asks = data.asks || data.a;
                
                if (bids && asks) {
                    this.binanceDepth.bids = bids.slice(0, this.depthLevels);
                    this.binanceDepth.asks = asks.slice(0, this.depthLevels);
                    if (this.status === 'RUNNING') {
                        this.syncGrid('BUY', this.binanceDepth.bids);
                        this.syncGrid('SELL', this.binanceDepth.asks);
                    }
                    broadcastToUI();
                    const bestBid = bids[0] ? bids[0][0] : '-';
                    const bestAsk = asks[0] ? asks[0][0] : '-';
                    const spread = (bestBid !== '-' && bestAsk !== '-') ? (parseFloat(bestAsk) - parseFloat(bestBid)).toFixed(2) : '-';
                    pushEvent('EVENT', this.symbol, `Binance Depth | Bid: $${bestBid} | Ask: $${bestAsk} | Spread: $${spread} | Levels: ${bids.length}/${asks.length}`, data, 'depth');
                }
            } catch (e) { log.debug && log.debug('SYSTEM', e.message); }
        });
        this.wsBinanceDepth.on('error', (err) => { pushEvent('ERROR', this.symbol, `Binance Depth WS error: ${err.message}`, null, 'ws'); });
        this.wsBinanceDepth.on('close', () => { pushEvent('WARN', this.symbol, `Binance Depth WS disconnected — reconnecting...`, null, 'ws'); this.wsBinanceDepth = null; setTimeout(() => this.startBinanceDepthWS(), 3000); });
    }

    startBinanceTradesWS() {
        if (this.wsBinanceTrades) return;
        const sym = this.sourceSymbol.toLowerCase(); // Using Source Symbol
        // NOTE: aggTrade stream is regionally blocked; raw 'trade' stream works and has identical fields (p, q, m)
        const url = `wss://fstream.binance.com/public/ws/${sym}@trade`;

        this.wsBinanceTrades = new WebSocket(url);
        this.wsBinanceTrades.on('open', () => {
            pushEvent('SUCCESS', this.symbol, `Binance Trades WS connected`, { stream: 'trade' }, 'ws');
            log.info(this.symbol, `[TRADES-WS] Connected to Binance trade stream for ${this.sourceSymbol} (status=${this.status}, tradeSync=${this.enableTradeSync})`);
        });
        let _gatedLogged = false;
        this.wsBinanceTrades.on('message', (raw) => {
            try {
                const data = JSON.parse(raw.toString());
                if (data.e === 'trade') {
                    this.binanceLtp = data.p;
                    const side = data.m ? 'SELL' : 'BUY';
                    pushEvent('EVENT', this.symbol, `Trade | ${side} | Price: ${data.p} | Qty: ${data.q}`, data, 'trade');
                    if (this.status === 'RUNNING' && this.enableTradeSync) {
                        _gatedLogged = false; // reset so we log again if it becomes gated later
                        this.tradeQueue.push({ p: data.p, q: data.q, m: data.m });
                        this.processTradeQueue();
                    } else if (!_gatedLogged) {
                        _gatedLogged = true;
                        log.warn(this.symbol, `[TRADES-WS] Trades arriving but gated (status=${this.status}, tradeSync=${this.enableTradeSync}). Will auto-activate when RUNNING.`);
                    }
                }
            } catch (e) { log.error(this.symbol, `[TRADES-WS] Message handler error: ${e.message}`); }
        });
        this.wsBinanceTrades.on('error', (err) => { log.error(this.symbol, `[TRADES-WS] Error: ${err.message}`); pushEvent('ERROR', this.symbol, `Binance Trades WS error: ${err.message}`, null, 'ws'); });
        this.wsBinanceTrades.on('close', () => { pushEvent('WARN', this.symbol, `Binance Trades WS disconnected — reconnecting...`, null, 'ws'); this.wsBinanceTrades = null; setTimeout(() => this.startBinanceTradesWS(), 3000); });
    }

    startBinanceTickerWS() {
        if (this.wsBinanceTicker) return;
        const sym = this.sourceSymbol.toLowerCase();
        const url = `wss://fstream.binance.com/public/ws/${sym}@ticker`;
        log.info(this.symbol, `[WS] Connecting to Binance 24h Ticker...`);
        this.wsBinanceTicker = new WebSocket(url);
        this.wsBinanceTicker.on('open', () => { pushEvent('SUCCESS', this.symbol, `Binance Ticker WS connected`, { stream: 'binanceTicker' }, 'ws'); });
        this.wsBinanceTicker.on('message', (raw) => {
            try {
                const data = JSON.parse(raw.toString());
                if (data.e === '24hrTicker' || data.c) {
                    this.binance24h = {
                        high: parseFloat(data.h || 0),
                        low: parseFloat(data.l || 0),
                        volume: parseFloat(data.v || 0),
                        priceChangePercent: parseFloat(data.P || 0)
                    };
                    if (data.c) {
                        this.binanceLtp = parseFloat(data.c);
                    }
                    broadcastToUI();
                    
                    if (!this.lastBinanceTickerLogTime || Date.now() - this.lastBinanceTickerLogTime > 5000) {
                        this.lastBinanceTickerLogTime = Date.now();
                        pushEvent('EVENT', this.symbol, `Binance 24h Ticker | High: ${this.binance24h.high.toFixed(2)} | Low: ${this.binance24h.low.toFixed(2)} | Vol: ${this.binance24h.volume.toFixed(0)}`, data, 'ticker');
                    }
                }
            } catch(e) { log.debug && log.debug('SYSTEM', e.message); }
        });
        this.wsBinanceTicker.on('error', (err) => { pushEvent('ERROR', this.symbol, `Binance Ticker WS error: ${err.message}`, null, 'ws'); });
        this.wsBinanceTicker.on('close', () => {
            this.wsBinanceTicker = null;
            setTimeout(() => this.startBinanceTickerWS(), 3000);
        });
    }

    startRestPollingFallback() {
        if (this.pollingInterval) clearInterval(this.pollingInterval);
        
        this.pollingInterval = setInterval(async () => {
            // 1. Fetch real-time Mark Price, Index Price, and Funding Rate for Binance and Stage
            try {
                const resB = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${this.sourceSymbol}`);
                if (resB.ok) {
                    const dataB = await resB.json();
                    if (dataB.markPrice) this.binanceMarkPrice = parseFloat(dataB.markPrice);
                    if (dataB.indexPrice) this.binanceIndexPrice = parseFloat(dataB.indexPrice);
                    if (dataB.lastFundingRate) this.binanceFundingRate = parseFloat(dataB.lastFundingRate);
                }
            } catch(e){}

            try {
                const mdsReadBase = (TIER_URLS[this.tier] && TIER_URLS[this.tier].MDS_READ) || TIER_URLS.PRODUCTION.MDS_READ;
                const resS = await fetch(`${mdsReadBase}/fapi/v1/premiumIndex?symbol=${this.symbol}`);
                if (resS.ok) {
                    const dataS = await resS.json();
                    if (dataS.markPrice) this.testnetMarkPrice = parseFloat(dataS.markPrice);
                    if (dataS.indexPrice) this.testnetIndexPrice = parseFloat(dataS.indexPrice);
                    if (dataS.lastFundingRate) this.stageFundingRate = parseFloat(dataS.lastFundingRate);
                }
            } catch(e){}

            // 2. Fetch real-time LTP for Binance and Stage
            try {
                const resLtpB = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${this.sourceSymbol}`);
                if (resLtpB.ok) {
                    const dataLtpB = await resLtpB.json();
                    if (dataLtpB.price) this.binanceLtp = parseFloat(dataLtpB.price);
                }
            } catch(e){}

            try {
                const mdsReadBase = (TIER_URLS[this.tier] && TIER_URLS[this.tier].MDS_READ) || TIER_URLS.PRODUCTION.MDS_READ;
                const resLtpS = await fetch(`${mdsReadBase}/fapi/v2/ticker/price?symbol=${this.symbol}`);
                if (resLtpS.ok) {
                    const dataLtpS = await resLtpS.json();
                    if (dataLtpS.price) this.testnetLtp = parseFloat(dataLtpS.price);
                }
            } catch(e){}

            // 3. Fetch real-time 24h Stats for Binance
            try {
                const res24B = await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${this.sourceSymbol}`);
                if (res24B.ok) {
                    const data24B = await res24B.json();
                    this.binance24h = {
                        high: parseFloat(data24B.highPrice || 0),
                        low: parseFloat(data24B.lowPrice || 0),
                        volume: parseFloat(data24B.volume || 0),
                        priceChangePercent: parseFloat(data24B.priceChangePercent || 0)
                    };
                }
            } catch(e){}

            broadcastToUI();
        }, 3000);
    }


    async fetchInitialMarkPrices() {
        const mdsReadBase = (TIER_URLS[this.tier] && TIER_URLS[this.tier].MDS_READ) || TIER_URLS.PRODUCTION.MDS_READ;
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
            const res = await fetch(`${mdsReadBase}/fapi/v1/premiumIndex?symbol=${this.symbol}`, { signal: controller.signal });
            if (res.ok) {
                const data = await res.json();
                if (data.markPrice) {
                    this.testnetMarkPrice = parseFloat(data.markPrice);
                }
                if (data.indexPrice) {
                    this.testnetIndexPrice = parseFloat(data.indexPrice);
                }
            }
        } catch (e) {
            log.debug && log.debug('SYSTEM', `Failed to fetch Stage initial markPrice: ${e.message}`);
        } finally {
            clearTimeout(timeout);
        }

        const controller2 = new AbortController();
        const timeout2 = setTimeout(() => controller2.abort(), 5000);
        try {
            const res = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${this.sourceSymbol}`, { signal: controller2.signal });
            if (res.ok) {
                const data = await res.json();
                if (data.markPrice) {
                    this.binanceMarkPrice = parseFloat(data.markPrice);
                }
                if (data.indexPrice) {
                    this.binanceIndexPrice = parseFloat(data.indexPrice);
                }
            }
        } catch (e) {
            log.debug && log.debug('SYSTEM', `Failed to fetch Binance initial markPrice: ${e.message}`);
        } finally {
            clearTimeout(timeout2);
        }
    }

    startTestnetMarkPriceWS() {
        if (this.wsTestnetMarkPrice) return;
        const sym = this.symbol.toLowerCase();
        const urls = TIER_URLS[this.tier] || TIER_URLS.PRODUCTION;
        const wsBase = urls.WS_GATEWAY;
        const streamUrl = `${wsBase}/market/ws/${sym}@markPrice`;
        log.info(this.symbol, `[WS] Connecting to Stage Mark Price WS...`);
        this.wsTestnetMarkPrice = new WebSocket(streamUrl);
        this.wsTestnetMarkPrice.on('open', () => {
            pushEvent('SUCCESS', this.symbol, `Stage Mark Price WS connected`, { stream: 'stageMarkPrice' }, 'ws');
        });
        this.wsTestnetMarkPrice.on('message', (raw) => {
            try {
                const data = JSON.parse(raw.toString());
                if (data.e === 'markPriceUpdate' || data.p) {
                    this.testnetMarkPrice = parseFloat(data.p || data.markPrice);
                    if (data.r !== undefined) {
                        this.stageFundingRate = parseFloat(data.r);
                    }
                    if (data.i !== undefined) {
                        this.testnetIndexPrice = parseFloat(data.i);
                    }
                    broadcastToUI();
                    
                    if (!this.lastTestnetMarkPriceLogTime || Date.now() - this.lastTestnetMarkPriceLogTime > 5000) {
                        this.lastTestnetMarkPriceLogTime = Date.now();
                        pushEvent('EVENT', this.symbol, `Stage Mark Price Update | Price: ${this.testnetMarkPrice.toFixed(2)} | Funding: ${this.stageFundingRate !== null ? this.stageFundingRate.toFixed(8) : '—'}`, data, 'markPrice');
                    }
                }
            } catch(e) { log.debug && log.debug('SYSTEM', e.message); }
        });
        this.wsTestnetMarkPrice.on('close', () => {
            pushEvent('WARN', this.symbol, `Stage Mark Price WS disconnected — reconnecting...`, null, 'ws');
            this.wsTestnetMarkPrice = null;
            setTimeout(() => this.startTestnetMarkPriceWS(), 3000);
        });
        this.wsTestnetMarkPrice.on('error', (err) => {
            pushEvent('ERROR', this.symbol, `Stage Mark Price WS error: ${err.message}`, null, 'ws');
        });
    }

    startBinanceMarkPriceWS() {
        if (this.wsBinanceMarkPrice) return;
        const sym = this.symbol.toLowerCase();
        const streamUrl = `wss://fstream.binance.com/public/ws/${sym}@markPrice`;
        log.info(this.symbol, `[WS] Connecting to Binance Mark Price WS...`);
        this.wsBinanceMarkPrice = new WebSocket(streamUrl);
        this.wsBinanceMarkPrice.on('open', () => {
            pushEvent('SUCCESS', this.symbol, `Binance Mark Price WS connected`, { stream: 'binanceMarkPrice' }, 'ws');
        });
        this.wsBinanceMarkPrice.on('message', (raw) => {
            try {
                const data = JSON.parse(raw.toString());
                if (data.e === 'markPriceUpdate' || data.p) {
                    this.binanceMarkPrice = parseFloat(data.p || data.markPrice);
                    if (data.r !== undefined) {
                        this.binanceFundingRate = parseFloat(data.r);
                    }
                    if (data.i !== undefined) {
                        this.binanceIndexPrice = parseFloat(data.i);
                    }
                    broadcastToUI();
                    
                    if (!this.lastBinanceMarkPriceLogTime || Date.now() - this.lastBinanceMarkPriceLogTime > 5000) {
                        this.lastBinanceMarkPriceLogTime = Date.now();
                        pushEvent('EVENT', this.symbol, `Binance Mark Price Update | Price: ${this.binanceMarkPrice.toFixed(2)} | Funding: ${this.binanceFundingRate !== null ? this.binanceFundingRate.toFixed(8) : '—'}`, data, 'markPrice');
                    }
                }
            } catch(e) { log.debug && log.debug('SYSTEM', e.message); }
        });
        this.wsBinanceMarkPrice.on('close', () => {
            pushEvent('WARN', this.symbol, `Binance Mark Price WS disconnected — reconnecting...`, null, 'ws');
            this.wsBinanceMarkPrice = null;
            setTimeout(() => this.startBinanceMarkPriceWS(), 3000);
        });
        this.wsBinanceMarkPrice.on('error', (err) => {
            pushEvent('ERROR', this.symbol, `Binance Mark Price WS error: ${err.message}`, null, 'ws');
        });
    }

    startTestnetTickerWS() {
        if (this.wsTestnetTicker) return;
        const sym = this.symbol.toLowerCase();
        const urls = TIER_URLS[this.tier] || TIER_URLS.PRODUCTION;
        const wsBase = urls.WS_GATEWAY;
        const streamUrl = `${wsBase}/market/ws/${sym}@ticker`;
        log.info(this.symbol, `[WS] Connecting to 24h Ticker...`);
        this.wsTestnetTicker = new WebSocket(streamUrl);
        this.wsTestnetTicker.on('open', () => { pushEvent('SUCCESS', this.symbol, `Testnet Ticker WS connected`, { stream: '24hrTicker' }, 'ws'); });
        this.wsTestnetTicker.on('message', (raw) => {
            try {
                const data = JSON.parse(raw.toString());
                if (data.e === '24hrTicker') {
                    this.testnetLtp = parseFloat(data.c);
                    this.stage24h = {
                        high: parseFloat(data.h || 0),
                        low: parseFloat(data.l || 0),
                        volume: parseFloat(data.v || 0),
                        priceChangePercent: parseFloat(data.P || 0)
                    };
                    broadcastToUI();
                    
                    if (!this.lastTestnetTickerLogTime || Date.now() - this.lastTestnetTickerLogTime > 5000) {
                        this.lastTestnetTickerLogTime = Date.now();
                        pushEvent('EVENT', this.symbol, `Stage 24h Ticker | High: ${this.stage24h.high.toFixed(2)} | Low: ${this.stage24h.low.toFixed(2)} | Vol: ${this.stage24h.volume.toFixed(0)}`, data, 'ticker');
                    }
                }
            } catch(e) { log.debug && log.debug('SYSTEM', e.message); }
        });
        this.wsTestnetTicker.on('close', () => { pushEvent('WARN', this.symbol, `Testnet Ticker WS disconnected — reconnecting...`, null, 'ws'); this.wsTestnetTicker = null; setTimeout(() => this.startTestnetTickerWS(), 3000); });
        this.wsTestnetTicker.on('error', (err) => { pushEvent('ERROR', this.symbol, `Testnet Ticker WS error: ${err.message}`, null, 'ws'); });
    }



    startTestnetWS() {
        clearInterval(this.testnetPingInterval);
        if (this.wsTestnet) return;
        const sym = this.symbol.toLowerCase(); // Target Symbol
        const urls = TIER_URLS[this.tier] || TIER_URLS.PRODUCTION;
        const wsBase = urls.WS_GATEWAY;
        const streamUrl = `${wsBase}/public/ws/${sym}@depth20`;
        this.wsTestnet = new WebSocket(streamUrl);
        this.wsTestnet.on('open', () => {
            pushEvent('SUCCESS', this.symbol, `Testnet Depth WS connected`, { stream: 'depth20' }, 'ws');
            this.testnetPingInterval = setInterval(() => { if (this.wsTestnet && this.wsTestnet.readyState === WebSocket.OPEN) this.wsTestnet.ping(); }, 30000);
        });

        this.wsTestnet.on('message', (raw) => {
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
        this.wsTestnet.on('close', () => { clearInterval(this.testnetPingInterval); pushEvent('WARN', this.symbol, `Testnet Depth WS disconnected — reconnecting...`, null, 'ws'); this.wsTestnet = null; setTimeout(() => this.startTestnetWS(), 3000); });
    }

    async cleanOpenOrders(user, tier, symbolFilter = null) {
        if (!user) return;
        const hpoBase = TIER_URLS[tier].HPO;
        let offset = 0;
        const limit = 500;
        const seenIds = new Set();
        while (true) {
            const query = { limit: limit, offset: offset };
            const res = await sendSignedRequest(`${hpoBase}/fapi/v1/openOrders`, 'GET', query, user, 60000, tier);
            if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) break;
            
            const chunk = res.data;
            let newCount = 0;
            const toCancel = [];
            for (const o of chunk) {
                const id = o.orderId || o.id;
                if (!seenIds.has(id)) {
                    seenIds.add(id);
                    newCount++;
                    if (!symbolFilter || o.symbol === symbolFilter) {
                        toCancel.push({ id, symbol: o.symbol });
                    }
                }
            }
            
            if (toCancel.length > 0) {
                const results = await Promise.allSettled(toCancel.map(o => {
                    return sendSignedRequest(`${hpoBase}/fapi/v1/order`, 'DELETE', { symbol: o.symbol, orderId: o.id }, user, 10000, tier);
                }));
                let editInProgressCount = 0;
                for (const r of results) {
                    if (r.status === 'fulfilled' && !r.value.ok && r.value.data) {
                        const msg = String(r.value.data.msg || '').toLowerCase();
                        if (msg.includes('edit is in progress') || msg.includes('edit_in_progress')) {
                            editInProgressCount++;
                        }
                    }
                }
                if (editInProgressCount > 5) {
                    log.error(symbolFilter || 'SYSTEM', `Detected ${editInProgressCount} orders stuck in EDIT_IN_PROGRESS. Aborting further cancels as these orders are un-cancellable by API.`);
                    break;
                }
            }
            
            if (newCount === 0 || chunk.length < limit) break;
            offset += limit;
            if (offset > 10000) break;
        }
    }

    async wipeOrders() {
        log.info(this.symbol, 'Wiping orders (15s timeout)...');
        const hpoBase = TIER_URLS[this.tier].HPO;
        const tierUsers = globalUsers[this.tier] || {};
        const tierRoles = globalRoles[this.tier] || { makerId: '', takerId: '' };
        const makerUser = tierUsers[tierRoles.makerId];
        const takerUser = tierUsers[tierRoles.takerId];

        // Try DELETE /fapi/v1/allOpenOrders first for rapid cleansing
        let bulkSuccess = false;
        try {
            const p1 = makerUser ? sendSignedRequest(`${hpoBase}/fapi/v1/allOpenOrders`, 'DELETE', { symbol: this.symbol }, makerUser, 10000, this.tier) : Promise.resolve({ ok: false });
            const p2 = takerUser ? sendSignedRequest(`${hpoBase}/fapi/v1/allOpenOrders`, 'DELETE', { symbol: this.symbol }, takerUser, 10000, this.tier) : Promise.resolve({ ok: false });
            const [r1, r2] = await Promise.all([p1, p2]);
            if ((!makerUser || r1.ok) && (!takerUser || r2.ok)) {
                bulkSuccess = true;
                log.success(this.symbol, 'Staging book cleansed (bulk).');
            }
        } catch(e) {
            log.debug && log.debug(this.symbol, 'Bulk cancel failed: ' + e.message);
        }

        if (!bulkSuccess) {
            await Promise.all([
                this.cleanOpenOrders(makerUser, this.tier, this.symbol),
                this.cleanOpenOrders(takerUser, this.tier, this.symbol)
            ]);
            log.success(this.symbol, 'Staging book cleansed.');
        }
        this.restingBids = []; this.restingAsks = [];
    }

    async reloadDepth() {
        log.info(this.symbol, 'Reloading engine streams and market depth...');
        
        // 1. Close all Testnet WebSockets
        if (this.wsTestnet) { clearInterval(this.testnetPingInterval); this.wsTestnet.removeAllListeners('close'); this.wsTestnet.close(); this.wsTestnet = null; }
        if (this.wsTestnetTicker) { try { this.wsTestnetTicker.removeAllListeners('close'); this.wsTestnetTicker.close(); } catch(e){} this.wsTestnetTicker = null; }
        if (this.wsTestnetMarkPrice) { try { this.wsTestnetMarkPrice.removeAllListeners('close'); this.wsTestnetMarkPrice.close(); } catch(e){} this.wsTestnetMarkPrice = null; }

        // 2. Close all Binance WebSockets
        if (this.wsBinanceDepth) { this.wsBinanceDepth.removeAllListeners('close'); this.wsBinanceDepth.close(); this.wsBinanceDepth = null; }
        if (this.wsBinanceTrades) { this.wsBinanceTrades.removeAllListeners('close'); this.wsBinanceTrades.close(); this.wsBinanceTrades = null; }
        if (this.wsBinanceTicker) { try { this.wsBinanceTicker.removeAllListeners('close'); this.wsBinanceTicker.close(); } catch(e){} this.wsBinanceTicker = null; }
        if (this.wsBinanceMarkPrice) { try { this.wsBinanceMarkPrice.removeAllListeners('close'); this.wsBinanceMarkPrice.close(); } catch(e){} this.wsBinanceMarkPrice = null; }

        // 3. Fetch initial depth from MDS_READ
        const mdsReadBase = TIER_URLS[this.tier].MDS_READ;
        const depthEndpoints = [
            `${mdsReadBase}/fapi/v1/depth?symbol=${this.symbol}&limit=${this.depthLevels}`,
            `${mdsReadBase}/api/v1/derivatives/futures/depth?symbol=${this.symbol}&limit=${this.depthLevels}`
        ];
        let success = false;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        for (const endpoint of depthEndpoints) {
            try {
                const res = await fetch(endpoint, { signal: controller.signal });
                if (res.ok) {
                    const data = await res.json();
                    if (data.bids && data.asks) { 
                        this.testnetDepth = { bids: data.bids, asks: data.asks }; 
                        broadcastToUI(); 
                        success = true;
                        break; 
                    }
                }
            } catch (e) { log.debug && log.debug('SYSTEM', e.message); }
        }
        clearTimeout(timeout);
        if (!success) {
            log.warn(this.symbol, `Failed to fetch initial depth from MDS_READ on ${this.tier}`, null, this.tier);
        }

        // 4. Fetch initial mark prices
        await this.fetchInitialMarkPrices();

        // 5. Restart all WebSockets
        this.startBinanceDepthWS();
        this.startBinanceTradesWS();
        this.startBinanceTickerWS();
        this.startBinanceMarkPriceWS();
        this.startTestnetWS();
        this.startTestnetTickerWS();
        this.startTestnetMarkPriceWS();
        
        log.success(this.symbol, 'All streams and depth successfully reloaded.');
    }

    async mountOnly() {
        this.status = 'STOPPED';
        log.info(this.symbol, 'Mounting market in data-only mode (simulation stopped)...', null, this.tier);
        
        // Fetch initial Binance LTP via REST
        try {
            const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${this.sourceSymbol}`);
            if (res.ok) {
                const data = await res.json();
                if (data && data.price) {
                    this.binanceLtp = parseFloat(data.price);
                }
            }
        } catch (e) {
            log.debug && log.debug('SYSTEM', `Failed to fetch initial Binance price: ${e.message}`);
        }
        
        // Fetch initial Stage LTP via REST
        try {
            const mdsReadBase = (TIER_URLS[this.tier] && TIER_URLS[this.tier].MDS_READ) || TIER_URLS.PRODUCTION.MDS_READ;
            const res = await fetch(`${mdsReadBase}/fapi/v2/ticker/price?symbol=${this.symbol}`);
            if (res.ok) {
                const data = await res.json();
                if (data && data.price) {
                    this.testnetLtp = parseFloat(data.price);
                }
            }
        } catch (e) {
            log.debug && log.debug('SYSTEM', `Failed to fetch initial Stage price: ${e.message}`);
        }

        await this.fetchInitialMarkPrices();
        await this.reloadDepth();
        this.startRestPollingFallback();
    }

    async start() {
        if (this.status === 'RUNNING') return;

        this.status = 'RUNNING'; this.hasLoggedAuthError = false;
        log.success(this.symbol, 'Engine Started.');

        // Set leverage for both maker and taker accounts on this symbol
        await this.setLeverage();

        // Fetch initial mark prices
        await this.fetchInitialMarkPrices();

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
        this.startBinanceMarkPriceWS();
        this.startBinanceTickerWS();
        this.startRestPollingFallback();
    }

    pause() { this.status = 'PAUSED'; log.warn(this.symbol, 'Engine Paused.'); }

    async setLeverage(leverage = 5) {
        const hpoBase = TIER_URLS[this.tier].HPO;
        const tierUsers = globalUsers[this.tier] || {};
        const tierRoles = globalRoles[this.tier] || { makerId: '', takerId: '' };
        const makerUser = tierUsers[tierRoles.makerId];
        const takerUser = tierUsers[tierRoles.takerId];
        const payload   = { symbol: this.symbol, leverage };

        const calls = [];
        if (makerUser) calls.push(
            sendSignedRequest(`${hpoBase}/fapi/v1/leverage`, 'POST', payload, makerUser, 10000, this.tier)
                .then(r => { if (r.ok) log.success(this.symbol, `[LEVERAGE] Maker leverage set to ${leverage}x`); else log.warn(this.symbol, `[LEVERAGE] Maker leverage update failed: ${JSON.stringify(r.data)}`); })
                .catch(e => log.warn(this.symbol, `[LEVERAGE] Maker leverage call error: ${e.message}`))
        );
        if (takerUser) calls.push(
            sendSignedRequest(`${hpoBase}/fapi/v1/leverage`, 'POST', payload, takerUser, 10000, this.tier)
                .then(r => { if (r.ok) log.success(this.symbol, `[LEVERAGE] Taker leverage set to ${leverage}x`); else log.warn(this.symbol, `[LEVERAGE] Taker leverage update failed: ${JSON.stringify(r.data)}`); })
                .catch(e => log.warn(this.symbol, `[LEVERAGE] Taker leverage call error: ${e.message}`))
        );
        await Promise.all(calls);
    }

    async stop() {
        this.status = 'STOPPED'; log.warn(this.symbol, 'Engine Stopped.');
        if (this.cancelOnStop) await this.wipeOrders(); else { this.restingBids = []; this.restingAsks = []; }
    }
}

// Auto-wrap prototype methods of ReplicatorInstance to run in AsyncLocalStorage context of this.tier
for (const key of Object.getOwnPropertyNames(ReplicatorInstance.prototype)) {
    if (key === 'constructor') continue;
    const original = ReplicatorInstance.prototype[key];
    if (typeof original === 'function') {
        ReplicatorInstance.prototype[key] = function(...args) {
            return tierContextStore.run(this.tier, () => {
                return original.apply(this, args);
            });
        };
    }
}

const instances = {
    PRODUCTION: new Map(),
    JAPAN: new Map(),
    STAGING: new Map()
};
let manualOverride = false;

// ==========================================
// 4. Global Portfolio & Master Loop
// ==========================================
function autoParsePositions(data, tier = 'PRODUCTION') {
    if (!Array.isArray(data)) return [];
    return data.filter(pos => parseFloat(pos.positionAmt || pos.size || 0) !== 0).map(pos => {
        const amt  = parseFloat(pos.positionAmt || pos.size || 0);
        const tierMap = instrumentsMap[tier] || {};
        const inst = tierMap[pos.symbol] || { pricePrecision: 4, qtyPrecision: 3 };
        return {
            symbol:        pos.symbol,
            side:          amt > 0 ? 'LONG' : 'SHORT',
            size:          Math.abs(amt).toFixed(inst.qtyPrecision),
            entryPrice:    parseFloat(pos.entryPrice || 0).toFixed(inst.pricePrecision),
            markPrice:     parseFloat(pos.markPrice  || 0).toFixed(inst.pricePrecision),
            unrealizedPnL: parseFloat(pos.unRealizedProfit || pos.unrealizedProfit || 0).toFixed(2),
            leverage:      pos.leverage || "5",
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

async function getUserPortfolio(userConfig, tier = 'PRODUCTION') {
    const urls = TIER_URLS[tier] || TIER_URLS.PRODUCTION;
    const hpoBase = urls.HPO;
    let accountData = null, positionData = null, errorMsg = null;
    let res = await sendSignedRequest(`${hpoBase}/fapi/v2/account`, 'GET', null, userConfig, 50000, tier);
    if (res.ok) accountData = res.data;
    else if (res.status === 401) errorMsg = `API Failed (401 Unauthorized)`;
    else errorMsg = `API Failed (${res.status})`;

    let posRes = await sendSignedRequest(`${hpoBase}/fapi/v2/positionRisk`, 'GET', null, userConfig, 50000, tier);
    if (posRes.ok) positionData = posRes.data;
    else if (!errorMsg) errorMsg = `Positions API Failed (${posRes.status})`;

    const portfolio = { walletBalance: "0.00", availableBalance: "0.00", unrealizedProfit: "0.00", positions: [], openOrders: [], orderHistory: [], openOrdersCount: 0, error: errorMsg };
    if (accountData) {
        const pAcc = autoParseAccount(accountData);
        portfolio.walletBalance    = pAcc.walletBalance;
        portfolio.availableBalance = pAcc.availableBalance;
        portfolio.unrealizedProfit = pAcc.unrealizedProfit;
    }
    if (positionData) portfolio.positions = autoParsePositions(positionData, tier);
    return portfolio;
}

let globalPortfolios = {
    PRODUCTION: {},
    JAPAN: {},
    STAGING: {}
};
let _prevPortfolioState = {}; // Track previous state for change detection

async function syncAllPortfolios() {
    const activeTiers = new Set([globalActiveTier]);
    
    await Promise.all(Array.from(activeTiers).map(async (tier) => {
        if (!globalPortfolios[tier]) globalPortfolios[tier] = {};
        
        const tierUsers = globalUsers[tier] || {};
        const userKeys = Object.keys(tierUsers);
        
        await Promise.all(userKeys.map(async (k) => {
            try {
                const port = await getUserPortfolio(tierUsers[k], tier);
                if (!globalPortfolios[tier][k]) {
                    globalPortfolios[tier][k] = port;
                } else {
                    const prevRealtimeOrders = globalPortfolios[tier][k]._realtimeOrders;
                    Object.assign(globalPortfolios[tier][k], port);
                    if (prevRealtimeOrders) {
                        globalPortfolios[tier][k]._realtimeOrders = prevRealtimeOrders;
                    }
                }
            } catch (e) {
                console.error(`[ERROR] Failed to sync portfolio for ${k} on tier ${tier}: ${e.message}`);
            }
        }));
    }));

    // Maintain backwards compatible globals pointing to the default active tier
    const tierRoles = globalRoles[globalActiveTier] || { makerId: '', takerId: '' };
    user1Portfolio = (globalPortfolios[globalActiveTier] && globalPortfolios[globalActiveTier][tierRoles.makerId]) || { walletBalance: "0.00", availableBalance: "0.00", unrealizedProfit: "0.00", positions: [], openOrdersCount: 0, error: null };
    user2Portfolio = (globalPortfolios[globalActiveTier] && globalPortfolios[globalActiveTier][tierRoles.takerId]) || { walletBalance: "0.00", availableBalance: "0.00", unrealizedProfit: "0.00", positions: [], openOrdersCount: 0, error: null };
}

async function globalMasterLoop() {
    try {
        const syncPromises = [];
        for (const tier of ['PRODUCTION', 'JAPAN', 'STAGING']) {
            const tierInstances = instances[tier] || new Map();
            for (const inst of tierInstances.values()) {
                if (inst.status === 'RUNNING') syncPromises.push(inst.runDeltaSync());
            }
        }
        await Promise.allSettled(syncPromises);

        const now = Date.now();
        if (lastPortfolioSyncTime === 0 || now - lastPortfolioSyncTime >= PORTFOLIO_SYNC_INTERVAL_MS) {
            lastPortfolioSyncTime = now;
            await syncAllPortfolios();
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
    const tierInstances = instances[globalActiveTier] || new Map();
    for (const [sym, inst] of tierInstances.entries()) {
        const tierMap = instrumentsMap[inst.tier] || {};
        const pData = tierMap[sym] || { pricePrecision: 4, qtyPrecision: 1 };
        activeInstancesMap[sym] = {
            status:       inst.status,
            binanceDepth: inst.binanceDepth,
            testnetDepth: inst.testnetDepth,
            syncedTrades: inst.syncedTrades,
            tier:         inst.tier,
            diagnostics: {
                sourceSymbol:    inst.sourceSymbol,
                testnetLatency:  inst.testnetLatency,
                testnetLtp:      inst.testnetLtp,
                testnetMarkPrice: inst.testnetMarkPrice,
                binanceMarkPrice: inst.binanceMarkPrice,
                binanceIndexPrice: inst.binanceIndexPrice,
                testnetIndexPrice: inst.testnetIndexPrice,
                testnetKline:    inst.testnetKline,
                binanceLatency:  inst.binanceLatency,
                binanceLtp:      inst.binanceLtp,
                syncRatio:       inst.totalSyncAttempts > 0 ? ((inst.successfulSyncs / inst.totalSyncAttempts) * 100).toFixed(1) : '100',
                pricePrecision:  pData.pricePrecision !== undefined ? pData.pricePrecision : 4,
                qtyPrecision:    pData.qtyPrecision !== undefined ? pData.qtyPrecision : 1,
                bufferPct:       inst.bufferPct,
                minSize:         inst.minSize,
                maxSize:         inst.maxSize,
                takerSize:       inst.takerSize,
                makerUseRawQty:  inst.makerUseRawQty,
                takerUseRawQty:  inst.takerUseRawQty,
                cancelOnStop:    inst.cancelOnStop,
                newUserFlow:     inst.newUserFlow,
                tradeDelayMs:    inst.tradeDelayMs,
                enableTradeSync: inst.enableTradeSync,
                binance24h:      inst.binance24h,
                stage24h:        inst.stage24h,
                binanceFundingRate: inst.binanceFundingRate,
                stageFundingRate:   inst.stageFundingRate
            },
            scenarioStatus: ScenarioEngine.getStatus(sym)
        };
    }
    // We send globalUsers keys (without secrets) and roles to the UI
    const usersMetadata = {};
    for (const tier of ['PRODUCTION', 'JAPAN', 'STAGING']) {
        usersMetadata[tier] = {};
        const tierUsers = globalUsers[tier] || {};
        for (const [k, u] of Object.entries(tierUsers)) {
            usersMetadata[tier][k] = { label: u.label, key: u.key, email: u.email };
        }
    }
    
    return JSON.stringify({ 
        instances: activeInstancesMap, 
        portfolios: globalPortfolios,
        users: usersMetadata,
        roles: globalRoles,
        activeTier: globalActiveTier,
        instruments: instrumentsMap,
        tierUrls: TIER_URLS,
        terminalLogs,
        terminalEvents: isSnapshot ? terminalEvents : terminalEvents.filter(e => e.ts > sinceTs),
        orderUpdateCounter: globalOrderUpdateCounter
    });
}

let lastBroadcastTime = 0;
let lastBroadcastEventsTs = 0;
function broadcastToUI(force = false) {
    const now = Date.now();
    if (!force && (now - lastBroadcastTime < 1000)) return;
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

// Authentication Sessions Map and Persistence
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const activeSessions = new Map();

function loadSessions() {
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
            for (const [sid, sess] of Object.entries(data)) {
                activeSessions.set(sid, sess);
            }
            log.info('SYSTEM', `Loaded ${activeSessions.size} active sessions from disk.`);
        }
    } catch (e) {
        log.error('SYSTEM', 'Failed to load sessions: ' + e.message);
    }
}

function saveSessions() {
    try {
        const obj = {};
        for (const [sid, sess] of activeSessions.entries()) {
            obj[sid] = sess;
        }
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
        log.error('SYSTEM', 'Failed to save sessions: ' + e.message);
    }
}

loadSessions();


function parseCookies(cookieHeader) {
    const list = {};
    if (!cookieHeader) return list;
    cookieHeader.split(';').forEach(cookie => {
        const parts = cookie.split('=');
        list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
    return list;
}

function getSessionSid(req) {
    if (req.headers['x-replicator-sid']) {
        return req.headers['x-replicator-sid'];
    }
    if (req.headers.authorization) {
        const parts = req.headers.authorization.split(' ');
        if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
            return parts[1];
        }
    }
    if (req.url) {
        const match = req.url.match(/[?&]sid=([^&#]+)/);
        if (match) {
            return match[1];
        }
    }
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.replicator_sid) {
        return cookies.replicator_sid;
    }
    return null;
}

const ENABLE_AUTH = true;

function getSessionUser(req) {
    if (!ENABLE_AUTH) {
        return { id: 'admin', email: 'admin@coindcx.com', label: 'Admin Administrator', tier: globalActiveTier };
    }
    // 1. Prioritize explicit request headers set by our client application
    if (req.headers['x-replicator-sid']) {
        const sid = req.headers['x-replicator-sid'];
        const sess = activeSessions.get(sid);
        if (sess) return sess;
    }
    if (req.headers.authorization) {
        const parts = req.headers.authorization.split(' ');
        if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
            const sid = parts[1];
            const sess = activeSessions.get(sid);
            if (sess) return sess;
        }
    }
    
    // 2. Check query parameter in URL (fallback)
    if (req.url) {
        const match = req.url.match(/[?&]sid=([^&#]+)/);
        if (match) {
            const sid = match[1];
            const sess = activeSessions.get(sid);
            if (sess) return sess;
        }
    }
    
    // 3. Fallback to standard cookie session (which might be stale/conflict)
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.replicator_sid) {
        const sid = cookies.replicator_sid;
        const sess = activeSessions.get(sid);
        if (sess) return sess;
    }
    
    return null;
}

const server = http.createServer(async (req, res) => {
    // Set CORS headers for all requests (including preflights and auth routes)
    let origin = req.headers.origin;
    if (!origin && req.headers.host) {
        const protocol = req.socket.encrypted ? 'https' : 'http';
        origin = `${protocol}://${req.headers.host}`;
    }
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-replicator-user, x-replicator-sid, authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
    }

    const pathname = (req.url || '').split('?')[0];

    // 1. Handle Auth Routes (No session check required)
    if (req.method === 'POST' && pathname === '/api/auth/login') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body || '{}');
                const email = parsed.email || '';
                const password = parsed.password || '';

                let matchedId = null;
                let matchedUser = null;

                // Check static admin credentials fallback
                if (email === 'admin@coindcx.com' && password === 'Test@123') {
                    matchedId = 'admin';
                    matchedUser = { email: 'admin@coindcx.com', label: 'Admin Administrator' };
                } else {
                    // Search in globalUsers for active tier
                    const tierUsers = globalUsers[globalActiveTier] || {};
                    for (const [id, user] of Object.entries(tierUsers)) {
                        if (user.email === email && user.password === password) {
                            matchedId = id;
                            matchedUser = user;
                            break;
                        }
                    }
                }

                if (matchedUser) {
                    const sid = uuidv4();
                    activeSessions.set(sid, { id: matchedId, email: matchedUser.email, label: matchedUser.label, tier: globalActiveTier });
                    saveSessions();
                    res.writeHead(200, {
                        'Set-Cookie': `replicator_sid=${sid}; Path=/; HttpOnly; SameSite=Strict`,
                        'Content-Type': 'application/json'
                    });
                    return res.end(JSON.stringify({ success: true, sid, user: { id: matchedId, email: matchedUser.email, label: matchedUser.label } }));
                } else {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'Invalid email or password' }));
                }
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    if (req.method === 'POST' && pathname === '/api/auth/register') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const parsed = JSON.parse(body || '{}');
                const username = parsed.username || '';
                const role = parsed.role || 'MAKER'; // MAKER or TAKER

                if (!username || !/^[a-zA-Z0-9_-]+$/.test(username)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'Invalid username format' }));
                }

                log.info('SYSTEM', `Registering new web account ${username} on ${globalActiveTier}...`);
                const { execFile } = require('child_process');
                const execFileAsync = require('util').promisify(execFile);
                const targetUrls = TIER_URLS[globalActiveTier] || TIER_URLS.PRODUCTION;

                const { stdout } = await execFileAsync('node', ['scripts/generate-single.js', username], {
                    env: {
                        ...process.env,
                        API_BASE: targetUrls.ONBOARDING,
                        RAILS_BASE: targetUrls.RAILS,
                        FUTURES_URL: targetUrls.HPO
                    }
                });

                const result = JSON.parse(stdout.trim());
                globalUsers[globalActiveTier] = globalUsers[globalActiveTier] || {};
                globalUsers[globalActiveTier][username] = {
                    label: username,
                    key: result.key,
                    secret: result.secret,
                    email: result.email,
                    password: 'Test@123',
                    listenKey: ''
                };

                // Assign role automatically if user requested it
                if (role === 'MAKER') {
                    globalRoles[globalActiveTier].makerId = username;
                } else {
                    globalRoles[globalActiveTier].takerId = username;
                }

                lastPortfolioSyncTime = 0;
                log.success('SYSTEM', `Web account ${username} registered successfully on ${globalActiveTier}.`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, email: result.email, password: 'Test@123' }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    if (pathname === '/api/auth/session') {
        const user = getSessionUser(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ authenticated: !!user, user }));
    }

    if (req.method === 'POST' && pathname === '/api/auth/logout') {
        const sid = getSessionSid(req);
        if (sid) {
            activeSessions.delete(sid);
            saveSessions();
        }
        res.writeHead(200, {
            'Set-Cookie': 'replicator_sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly',
            'Content-Type': 'application/json'
        });
        return res.end(JSON.stringify({ success: true }));
    }

    // 2. Gate All Other Pages/API Requests Behind Authentication Session
    const session = getSessionUser(req);
    const isHtmlRoute = pathname === '/' || pathname === '/index.html';

    if (!session && !pathname.startsWith('/api/auth/')) {
        if (isHtmlRoute) {
            // Render index.html anyway, the frontend will show the glassmorphic auth overlay
        } else {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Authentication required' }));
        }
    }

    if (req.method === 'POST' && pathname === '/api/instance/select') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const parsed = JSON.parse(body || '{}');
                const sym = (parsed.symbol || '').toUpperCase();
                const tier = (parsed.tier || globalActiveTier).toUpperCase();
                if (!sym) {
                    res.writeHead(400);
                    return res.end(JSON.stringify({ error: "Symbol is required" }));
                }
                const tierInstances = instances[tier];
                const inst = tierInstances ? tierInstances.get(sym) : null;
                if (inst) {
                    await inst.reloadDepth();
                    broadcastToUI(true);
                }
                res.writeHead(200);
                return res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(500);
                return res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // CORS headers handled globally at top of server handler

    if (req.method === 'GET' && pathname.startsWith('/api/stage/exchangeInfo')) {
        const urlObj = new URL(req.url, 'http://localhost');
        const tier = (urlObj.searchParams.get('tier') || globalActiveTier).toUpperCase();
        const urls = TIER_URLS[tier] || TIER_URLS.PRODUCTION;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);
            const stageRes = await fetch(`${urls.HPO}/fapi/v1/exchangeInfo`, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (stageRes.ok) {
                const info = await stageRes.json();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(info));
            } else {
                res.writeHead(stageRes.status, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: `Stage HPO returned status ${stageRes.status}` }));
            }
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
        }
    }

    if (req.method === 'GET' && pathname.startsWith('/api/stage/ticker/price')) {
        const urlObj = new URL(req.url, 'http://localhost');
        const tier = (urlObj.searchParams.get('tier') || globalActiveTier).toUpperCase();
        const urls = TIER_URLS[tier] || TIER_URLS.PRODUCTION;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);
            const stageRes = await fetch(`${urls.MDS_READ}/fapi/v2/ticker/price`, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (stageRes.ok) {
                const data = await stageRes.json();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(data));
            } else {
                res.writeHead(stageRes.status, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: `Stage MDS_READ returned status ${stageRes.status}` }));
            }
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
        }
    }

    if (req.method === 'GET' && pathname.startsWith('/api/stage/premiumIndex')) {
        const urlObj = new URL(req.url, 'http://localhost');
        const tier = (urlObj.searchParams.get('tier') || globalActiveTier).toUpperCase();
        const urls = TIER_URLS[tier] || TIER_URLS.PRODUCTION;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);
            const stageRes = await fetch(`${urls.MDS_READ}/fapi/v1/premiumIndex`, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (stageRes.ok) {
                const data = await stageRes.json();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(data));
            } else {
                res.writeHead(stageRes.status, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: `Stage MDS_READ returned status ${stageRes.status}` }));
            }
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
        }
    }

    if (req.method === 'GET' && pathname.startsWith('/api/fundingRate')) {
        const urlObj = new URL(req.url, 'http://localhost');
        const sym = (urlObj.searchParams.get('symbol') || '').toUpperCase();
        const tier = (urlObj.searchParams.get('tier') || globalActiveTier).toUpperCase();
        
        if (!sym) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: "Symbol is required" }));
        }

        try {
            // Lookup source symbol for Binance mapping if instance is running
            const tierInstances = instances[tier];
            const inst = tierInstances ? tierInstances.get(sym) : null;
            const sourceSym = inst ? inst.sourceSymbol : sym;

            // Fetch Binance funding rate with 5s timeout
            let binanceRate = null;
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);
                const binRes = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sourceSym}`, { signal: controller.signal });
                clearTimeout(timeoutId);
                if (binRes.ok) {
                    const binData = await binRes.json();
                    binanceRate = parseFloat(binData.lastFundingRate || 0);
                }
            } catch (e) {
                log.error(sym, `Failed to fetch Binance premiumIndex: ${e.message}`);
            }

            // Fetch Stage funding rate
            let stageRate = null;
            const mdsBase = TIER_URLS[tier] && TIER_URLS[tier].MDS_READ;
            if (mdsBase) {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 5000);
                    const stageRes = await fetch(`${mdsBase}/fapi/v1/fundingRate?symbol=${sym}`, { signal: controller.signal });
                    clearTimeout(timeoutId);
                    if (stageRes.ok) {
                        const stageData = await stageRes.json();
                        if (Array.isArray(stageData) && stageData.length > 0) {
                            const latest = stageData[stageData.length - 1];
                            stageRate = parseFloat(latest.fundingRate || 0);
                        }
                    }
                } catch (e) {
                    log.error(sym, `Failed to fetch Stage fundingRate on ${tier}: ${e.message}`);
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                binance: binanceRate,
                stage: stageRate,
                diff: (binanceRate !== null && stageRate !== null) ? (binanceRate - stageRate) : null
            }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
        }
    }

    if (req.method === 'DELETE' && pathname.startsWith('/api/instance')) {
        const urlObj = new URL(req.url, 'http://localhost');
        const sym = (urlObj.searchParams.get('symbol') || '').toUpperCase();
        const tier = (urlObj.searchParams.get('tier') || globalActiveTier).toUpperCase();
        
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                let parsed = {};
                try { parsed = JSON.parse(body || '{}'); } catch(e) {}
                const targetSym = sym || (parsed.symbol ? parsed.symbol.toUpperCase() : null);
                const targetTier = tier || (parsed.tier || globalActiveTier).toUpperCase();
                
                if (!targetSym) {
                    res.writeHead(400);
                    return res.end(JSON.stringify({ error: "Symbol is required" }));
                }
                const tierInstances = instances[targetTier];
                if (tierInstances && tierInstances.has(targetSym)) {
                    const inst = tierInstances.get(targetSym);
                    await inst.stop();
                    if (inst.pollingInterval) {
                        clearInterval(inst.pollingInterval);
                        inst.pollingInterval = null;
                    }
                    tierInstances.delete(targetSym);
                    log.info(targetSym, `Market instance deleted/removed from UI.`, null, targetTier);
                    broadcastToUI();
                    res.writeHead(200);
                    return res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(404);
                    return res.end(JSON.stringify({ error: "Instance not found" }));
                }
            } catch (e) {
                res.writeHead(500);
                return res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (pathname === '/events') {
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
                if (!sym && 
                    !pathname.startsWith('/api/users') && 
                    !pathname.startsWith('/api/manual-override') && 
                    !pathname.startsWith('/api/env') && 
                    !pathname.startsWith('/api/mds-proxy') && 
                    !pathname.startsWith('/fapi/v1/openOrders')
                ) {
                    throw new Error("Symbol is required");
                }
                if (pathname.startsWith('/fapi/')) {
                    const userId = req.headers['x-replicator-user'];
                    if (!userId) { res.writeHead(400); return res.end(JSON.stringify({ error: "Missing x-replicator-user header" })); }
                    const tierUsers = globalUsers[globalActiveTier] || {};
                    const userCreds = tierUsers[userId];
                    if (!userCreds) { res.writeHead(400); return res.end(JSON.stringify({ error: "Invalid user ID" })); }
                    try {
                        const httpMethod = parsed._method || 'POST';
                        delete parsed._method;
                        const hpoBase = TIER_URLS[globalActiveTier].HPO;
                        const apiRes = await sendSignedRequest(`${hpoBase}${req.url}`, httpMethod, parsed, userCreds, 50000, globalActiveTier);
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

                if (pathname.startsWith('/api/scenario/preset/')) {
                    const presetName = pathname.split('/').pop();
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

                if (pathname === '/api/scenario/custom') {
                    try {
                        const inst = (instances[globalActiveTier] || new Map()).get(targetSym);
                        const currentLtp = inst ? inst.binanceLtp : null;
                        const state = ScenarioEngine.startScenario(sym, parsed, currentLtp);
                        res.writeHead(200); return res.end(JSON.stringify({ success: true, state }));
                    } catch (e) {
                        res.writeHead(400); return res.end(JSON.stringify({ error: e.message }));
                    }
                }

                if (pathname === '/api/mds-proxy') {
                    const targetPath = parsed.path;
                    const activeTier = (parsed.tier || globalActiveTier || 'PRODUCTION').toUpperCase();
                    if (!targetPath) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: 'Missing path parameter' }));
                    }
                    const TIER_MDS_READ_URLS = {
                        PRODUCTION: "https://testnet-futures-mds-read.dcxstage.com",
                        JAPAN: "https://testnet-exchange-mds-read.dcxstage.com",
                        STAGING: "https://staging-exchange-futures-mds-read.dcxstage.com"
                    };
                    const mdsBase = TIER_MDS_READ_URLS[activeTier] || TIER_MDS_READ_URLS.PRODUCTION;
                    const finalUrl = `${mdsBase}${targetPath}`;
                    try {
                        const mdsRes = await fetch(finalUrl);
                        const data = await mdsRes.text();
                        if (!mdsRes.ok) {
                            console.error(`[MDS PROXY ERROR] Status ${mdsRes.status} from ${finalUrl}. Body: ${data.substring(0, 300)}`);
                        }
                        res.writeHead(mdsRes.status, { 'Content-Type': 'application/json' });
                        return res.end(data);
                    } catch (err) {
                        console.error(`[MDS PROXY CRASH] Failed to fetch ${finalUrl}: ${err.message}`);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ error: `MDS proxy failed: ${err.message}` }));
                    }
                }

                if (pathname === '/api/env') {
                    const tier = (parsed.tier || 'PRODUCTION').toUpperCase();
                    if (!TIER_URLS[tier]) {
                        res.writeHead(400);
                        return res.end(JSON.stringify({ error: `Invalid tier: ${tier}` }));
                    }
                    if (globalActiveTier !== tier) {
                        (async () => {
                            try {
                                await switchEnvironment(tier);
                                broadcastToUI(true);
                                log.success('SYSTEM', `Successfully switched global environment view to ${tier}`);
                            } catch (err) {
                                log.error('SYSTEM', `Error switching environment to ${tier}: ${err.message}`);
                            }
                        })();
                    }
                    res.writeHead(200);
                    return res.end(JSON.stringify({ success: true, tier: globalActiveTier }));
                }

                if (pathname === '/api/config') {
                    const tier = (parsed.tier || 'PRODUCTION').toUpperCase();
                    if (!instances[tier]) instances[tier] = new Map();
                    let inst = instances[tier].get(targetSym);
                    
                    if (!instrumentsMap[tier] || Object.keys(instrumentsMap[tier]).length === 0) {
                        await loadInstruments(tier);
                    }

                    if (!inst) {
                        inst = new ReplicatorInstance({
                            sourceSymbol: sym,
                            targetSymbol: targetSym,
                            tier: tier,
                            minSize: parseFloat(parsed.minSize || 10),
                            maxSize: parseFloat(parsed.maxSize || 50000),
                            takerSize: parseFloat(parsed.takerSize || 10),
                            makerUseRawQty: Boolean(parsed.makerUseRawQty),
                            takerUseRawQty: Boolean(parsed.takerUseRawQty),
                            depthLevels: parseInt(parsed.depthLevels || 20),
                            bufferPct: parseFloat(parsed.bufferPct || 0),
                            tradeDelayMs: parseInt(parsed.tradeDelayMs || 0),
                            cancelOnStop: Boolean(parsed.cancelOnStop),
                            newUserFlow: Boolean(parsed.newUserFlow),
                            enableTradeSync: parsed.enableTradeSync !== false
                        });
                        instances[tier].set(targetSym, inst);
                        if (parsed.mountOnly) {
                            await inst.mountOnly().catch(e => log.error(targetSym, `Mount failed: ${e.message}`, null, tier));
                            log.info(targetSym, `New market mounted in data-only mode.`, null, tier);
                        } else {
                            await inst.start().catch(e => log.error(targetSym, `Start failed: ${e.message}`, null, tier));
                            log.info(targetSym, `New market mounted from UI.`, null, tier);
                        }
                    } else {
                        if (parsed.minSize     !== undefined) inst.minSize     = parseFloat(parsed.minSize);
                        if (parsed.maxSize     !== undefined) inst.maxSize     = parseFloat(parsed.maxSize);
                        if (parsed.takerSize   !== undefined) inst.takerSize   = parseFloat(parsed.takerSize);
                        if (parsed.makerUseRawQty !== undefined) inst.makerUseRawQty = Boolean(parsed.makerUseRawQty);
                        if (parsed.takerUseRawQty !== undefined) inst.takerUseRawQty = Boolean(parsed.takerUseRawQty);
                        if (parsed.depthLevels !== undefined) inst.depthLevels = parseInt(parsed.depthLevels);
                        if (parsed.bufferPct   !== undefined) inst.bufferPct   = parseFloat(parsed.bufferPct);
                        if (parsed.cancelOnStop !== undefined) inst.cancelOnStop = Boolean(parsed.cancelOnStop);
                        if (parsed.tradeDelayMs !== undefined) inst.tradeDelayMs = parseInt(parsed.tradeDelayMs);
                        if (parsed.newUserFlow !== undefined) inst.newUserFlow = Boolean(parsed.newUserFlow);
                        // Use !== false comparison so string 'false' is treated correctly
                        if (parsed.enableTradeSync !== undefined) inst.enableTradeSync = parsed.enableTradeSync !== false && parsed.enableTradeSync !== 'false';
                        log.info(targetSym, `Config updated for existing instance.`, null, tier);
                    }

                    if (globalActiveTier !== tier) {
                        (async () => {
                            try {
                                await switchEnvironment(tier);
                                broadcastToUI(true);
                            } catch (err) {
                                log.error('SYSTEM', `Error finalizing switch: ${err.message}`);
                            }
                        })();
                    }
                    res.writeHead(200);
                    return res.end(JSON.stringify({ success: true }));
                } else if (pathname === '/api/manual-override') {
                    manualOverride = Boolean(parsed.locked);
                    log.info('SYSTEM', `Manual override set to ${manualOverride}`);
                } else if (pathname === '/api/users') {
                    if (parsed.action === 'add' || parsed.action === 'update') {
                        const { id, label, key, secret, listenKey } = parsed.user;
                        if (!id) throw new Error("User ID is required");
                        globalUsers[globalActiveTier] = globalUsers[globalActiveTier] || {};
                        globalUsers[globalActiveTier][id] = { label: label || id, key: key || '', secret: secret || '', listenKey: listenKey || '' };
                        lastPortfolioSyncTime = 0;
                        log.info('SYSTEM', `User ${id} saved on ${globalActiveTier}.`);
                    } else if (parsed.action === 'setRoles') {
                        globalRoles[globalActiveTier] = globalRoles[globalActiveTier] || { makerId: '', takerId: '' };
                        if (parsed.makerId) globalRoles[globalActiveTier].makerId = parsed.makerId;
                        if (parsed.takerId) globalRoles[globalActiveTier].takerId = parsed.takerId;
                        lastPortfolioSyncTime = 0;
                        log.info('SYSTEM', `Roles updated on ${globalActiveTier}: Maker=${globalRoles[globalActiveTier].makerId}, Taker=${globalRoles[globalActiveTier].takerId}`);
                        reconnectAllInstancesPrivateWs(globalActiveTier);
                    } else if (parsed.action === 'generate') {
                        const id = parsed.id;
                        if (!id) throw new Error("User ID is required for generation");
                        if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid user ID format');
                        log.info('SYSTEM', `Generating new user credentials for ${id} on ${globalActiveTier}...`);
                        const { execFile } = require('child_process');
                        const execFileAsync = require('util').promisify(execFile);
                        const targetUrls = TIER_URLS[globalActiveTier] || TIER_URLS.PRODUCTION;
                        const { stdout } = await execFileAsync('node', ['scripts/generate-single.js', id], {
                            env: {
                                ...process.env,
                                API_BASE: targetUrls.ONBOARDING,
                                RAILS_BASE: targetUrls.RAILS,
                                FUTURES_URL: targetUrls.HPO
                            }
                        });
                        const result = JSON.parse(stdout.trim());
                        globalUsers[globalActiveTier] = globalUsers[globalActiveTier] || {};
                        globalUsers[globalActiveTier][id] = { label: id, key: result.key, secret: result.secret, email: result.email, listenKey: '' };
                        lastPortfolioSyncTime = 0;
                        log.info('SYSTEM', `User ${id} generated successfully on ${globalActiveTier}.`);
                    } else if (parsed.action === 'delete') {
                        const id = parsed.id;
                        const tierRoles = globalRoles[globalActiveTier] || { makerId: '', takerId: '' };
                        if (tierRoles.makerId === id || tierRoles.takerId === id) {
                            throw new Error("Cannot delete a user currently assigned as Maker or Taker.");
                        }
                        if (globalUsers[globalActiveTier]) delete globalUsers[globalActiveTier][id];
                        if (globalPortfolios[globalActiveTier]) delete globalPortfolios[globalActiveTier][id];
                        log.info('SYSTEM', `User ${id} deleted from ${globalActiveTier}.`);
                    }
                } else {
                    const inst = (instances[globalActiveTier] || new Map()).get(targetSym);
                    if (pathname === '/api/engine/start'  && inst) inst.start();
                    else if (pathname === '/api/engine/pause'  && inst) inst.pause();
                    else if (pathname === '/api/engine/stop'   && inst) await inst.stop();
                    else if (pathname === '/api/engine/reload' && inst) inst.reloadDepth();
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
                
                if (pathname === '/api/scenario/active') {
                    const aborted = ScenarioEngine.abortScenario(sym);
                    res.writeHead(200); return res.end(JSON.stringify({ success: true, aborted }));
                }
            } catch (e) {
                res.writeHead(400); return res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (pathname === '/api/snapshot' && req.method === 'GET') {
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

    if (pathname === '/api/connections' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }).end(JSON.stringify({ activeSSE: sseClients.length }));
        return;
    }

    if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 
            'Content-Type': 'text/html',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        }).end(getHtmlUI());
        return;
    }
    res.writeHead(404).end();
});

// ==========================================
// 6. Main Execution Control
// ==========================================

async function globalStartupCleanup() {
    log.info('SYSTEM', 'Performing startup safety cleanup of all open orders across accounts (by symbol)...');
    const tiers = ['PRODUCTION', 'JAPAN', 'STAGING'].filter(t => t === globalActiveTier);
    for (const tier of tiers) {
        const hpoBase = TIER_URLS[tier] ? TIER_URLS[tier].HPO : null;
        if (!hpoBase) continue;
        const tierUsers = globalUsers[tier] || {};
        const tierRoles = globalRoles[tier] || { makerId: '', takerId: '' };
        const makerUser = tierUsers[tierRoles.makerId];
        const takerUser = tierUsers[tierRoles.takerId];
        
        // Get all loaded instruments symbols for this tier to do targeted cleanup
        const symbols = Object.keys(instrumentsMap[tier] || {});
        if (symbols.length === 0) {
            log.info('SYSTEM', `No loaded instruments for ${tier}. Skipping cleanup.`);
            continue;
        }
        
        const cleanUserOrders = async (user, label) => {
            if (!user) return;
            try {
                log.info('SYSTEM', `Performing startup open orders wipe for ${label} on ${tier}...`);
                // We instantiate a dummy instance config to run cleanOpenOrders helper
                const dummyInst = new ReplicatorInstance({ sourceSymbol: 'BTCUSDT', targetSymbol: 'BTCUSDT', tier });
                await dummyInst.cleanOpenOrders(user, tier, null); // Cancel ALL symbols
                log.success('SYSTEM', `Successfully cleansed startup open orders for ${label} on ${tier}.`);
            } catch(e) {
                log.debug && log.debug('SYSTEM', `Failed startup clean for ${label} on ${tier}: ` + e.message);
            }
        };
        
        await Promise.allSettled([
            cleanUserOrders(makerUser, 'Maker'),
            cleanUserOrders(takerUser, 'Taker')
        ]);
    }
}

async function startBots() {
    log.success('SYSTEM', '===========================================================');
    log.success('SYSTEM', `Starting ${marketConfigs.length} market replicator(s)...`);
    log.success('SYSTEM', '===========================================================');

    const tiers = ['PRODUCTION', 'JAPAN', 'STAGING'];
    const loadInstPromises = tiers.map(t => loadInstruments(t));

    await Promise.allSettled([syncServerTime(), ...loadInstPromises]);
    
    // Wipe all orphaned open orders across accounts in background
    globalStartupCleanup().catch(e => {
        log.error('SYSTEM', 'Startup global cleanup failed: ' + e.message);
    });
    
    // Fetch listen keys and connect user data streams for real-time events
    await fetchListenKeys();
    startListenKeyKeepalive();
    
    for (const marketConf of marketConfigs) {
        const targetSym = (marketConf.targetSymbol || marketConf.sourceSymbol).toUpperCase();
        const tier = (marketConf.tier || globalActiveTier).toUpperCase();
        if (!instances[tier]) instances[tier] = new Map();
        if (instances[tier].has(targetSym)) {
            log.warn(targetSym, 'Skipping duplicate market configuration.', null, tier);
            continue;
        }
        marketConf.tier = tier;
        log.info(targetSym, `Initializing market: ${marketConf.sourceSymbol} -> ${targetSym} on tier ${tier}`, null, tier);
        const inst = new ReplicatorInstance(marketConf);
        instances[tier].set(targetSym, inst);
    }

    const startPromises = [];
    for (const tier of tiers) {
        const tierInstances = instances[tier] || new Map();
        for (const inst of tierInstances.values()) {
            if (tier !== globalActiveTier) {
                // Initialize temporary previous state so it can be resumed when switched to
                inst.tempPrevStatus = inst.mountOnlyState ? 'STOPPED' : 'RUNNING';
                continue;
            }
            startPromises.push((async () => {
                try {
                    await inst.wipeOrders();
                    if (inst.mountOnlyState) {
                        await inst.mountOnly();
                    } else {
                        await inst.start();
                    }
                } catch (e) {
                    log.error(inst.targetSymbol, `Initial start sequence failed: ${e.message}`, null, inst.tier);
                }
            })());
        }
    }
    await Promise.allSettled(startPromises);

    globalMasterLoop();
    setInterval(syncServerTime, 60 * 60 * 1000);
    setInterval(async () => {
        await loadInstruments(globalActiveTier);
    }, 6 * 60 * 60 * 1000);
}

// SSE keepalive pings to prevent browser/proxy connection drops
setInterval(() => sseClients.forEach(c => c.write(`: keepalive\n\n`)), 15000);

// ENABLE_LOCAL_UI controls whether the HTTP/UI server is started.
// Set to 'false' via env var for fully headless Jenkins runs.
// Defaults to true so local development always has the UI.
const ENABLE_LOCAL_UI = process.env.ENABLE_LOCAL_UI !== 'false';

if (ENABLE_LOCAL_UI) {
    const UI_PORT = process.env.UI_PORT || 3000;
    server.listen(UI_PORT, async () => {
        const os = require('os');
        const hostName = os.hostname();
        let hostIp = 'localhost';
        try {
            const interfaces = os.networkInterfaces();
            for (const name of Object.keys(interfaces)) {
                for (const iface of interfaces[name]) {
                    if (iface.family === 'IPv4' && !iface.internal) {
                        hostIp = iface.address;
                        break;
                    }
                }
                if (hostIp !== 'localhost') break;
            }
        } catch (e) {}

        log.success('SYSTEM', '===========================================================');
        log.success('SYSTEM', 'Replicator Active.');
        log.success('SYSTEM', `UI available at: http://localhost:${UI_PORT}`);
        log.success('SYSTEM', `SSH Tunnel (run on your laptop): ssh -L 3005:localhost:${UI_PORT} <ssh-user>@${hostIp}`);
        log.success('SYSTEM', `Alternative hostname: ssh -L 3005:localhost:${UI_PORT} <ssh-user>@${hostName}`);
        log.success('SYSTEM', 'Then open: http://localhost:3005 in your browser');
        log.success('SYSTEM', '===========================================================');

        startBots().catch(err => {
            log.critical('SYSTEM', `A fatal error occurred during bot startup: ${err.message}`);
            process.exit(1);
        });
    });
} else {
    log.success('SYSTEM', '===========================================================');
    log.success('SYSTEM', 'Replicator Active — running HEADLESS (UI disabled).');
    log.success('SYSTEM', '===========================================================');

    startBots().catch(err => {
        log.critical('SYSTEM', `A fatal error occurred during bot startup: ${err.message}`);
        process.exit(1);
    });
}


process.on('SIGINT', async () => {
    log.warn('SYSTEM', 'Termination signal caught. Stopping all engines...');
    for (const tier of ['PRODUCTION', 'JAPAN', 'STAGING']) {
        const tierInstances = instances[tier] || new Map();
        for (const inst of tierInstances.values()) {
            await inst.stop();
        }
    }
    process.exit(0);
});

// ==========================================
// 7. UI Render
// ==========================================
function getHtmlUI() {
    return require('fs').readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
}
