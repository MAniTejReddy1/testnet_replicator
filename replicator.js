const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const AbortController = require('abort-controller');
const fetch = require('node-fetch');

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
    } catch {}
}


// ==========================================
// 1. Core Configuration & State
// ==========================================

// API Keys are hardcoded here for security in the CI/CD environment.
const HARDCODED_CREDENTIALS = {
    user1_maker: {
        key: process.env.USER1_KEY || '45cda3aac77c85a66212c1eb1ed70df06defc46e8840aa6d',
        secret: process.env.USER1_SECRET || 'b3ebd30860c13a1bd1f44c358d746874ae52ca5396879de71366c5b2832596fd',
        email: 'mani.reddy+k0g0zvg8@coindcx.com',
        password: 'Test@123'
    },
    user2_taker: {
        key: process.env.USER2_KEY || '6e3ef60d1fcfc8fb6c527eb8218bcdfaf56c02f422846367',
        secret: process.env.USER2_SECRET || 'ce547e76586bfe7d1fff793cb9373d04171b648f89de4706e7b9b2783715e72f',
        email: 'mani.reddy+n1d5l3gq@coindcx.com',
        password: 'Test@123'
    }
};

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
let user1Portfolio = { walletBalance: "0.00", availableBalance: "0.00", unrealizedProfit: "0.00", positions: [], openOrdersCount: 0, error: null };
let user2Portfolio = { walletBalance: "0.00", availableBalance: "0.00", unrealizedProfit: "0.00", positions: [], openOrdersCount: 0, error: null };
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

const log = {
    info:     (sym, msg) => console.log(`[\x1b[34mINFO\x1b[0m][${sym}] ${msg}`),
    success:  (sym, msg) => console.log(`[\x1b[32mSUCCESS\x1b[0m][${sym}] ${msg}`),
    error:    (sym, msg) => console.error(`[\x1b[31mERROR\x1b[0m][${sym}] ${msg}`),
    warn:     (sym, msg) => console.log(`[\x1b[33mWARN\x1b[0m][${sym}] ${msg}`),
    critical: (sym, msg) => console.log(`[\x1b[41m\x1b[37mCRITICAL\x1b[0m][${sym}] ${msg}`),
    debug:    (sym, msg) => { if (DEBUG) console.log(`[\x1b[35mDEBUG\x1b[0m][${sym}] ${msg}`); }
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
        if (payloadObj) {
            Object.keys(payloadObj).forEach(k => urlObj.searchParams.set(k, String(payloadObj[k])));
        }
        payloadStr = '';
    } else {
        const bodyObj = { ...payloadObj, timestamp };
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

    try {
        const options = { method: method.toUpperCase(), headers, body: payloadStr || undefined, signal: controller.signal };
        const res = await fetch(finalUrl, options);
        clearTimeout(timeoutId);

        const latencyMs = Date.now() - startTime;
        const text = await res.text();
        if (!res.ok || DEBUG) log.debug('REST-API', `[${method.toUpperCase()}] ${finalUrl} | Status: ${res.status} | Body: ${text} | Latency: ${latencyMs}ms`);

        let data;
        try { data = JSON.parse(text); }
        catch (e) { data = { error: text || 'Invalid JSON response from server' }; }

        return { ok: res.ok, status: res.status, data, latencyMs };
    } catch (err) {
        clearTimeout(timeoutId);
        const latencyMs = Date.now() - startTime;
        const isTimeout = err.name === 'AbortError' || err.message.includes('aborted');
        if (isTimeout) log.error('REST-API', `[TIMEOUT] ${method.toUpperCase()} to ${finalUrl} timed out after ${latencyMs}ms.`);
        else log.error('REST-API', `[ERROR] ${method.toUpperCase()} to ${finalUrl} failed after ${latencyMs}ms: ${err.message}`);
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
        } catch (e) {}
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
    let qty = Math.floor(rawQty * factor) / factor;
    if (qty < inst.minQty) qty = inst.minQty;

    return qty.toFixed(inst.qtyPrecision);
}

function formatRawQty(rawQty, symbol) {
    const inst = instrumentsMap[symbol] || { qtyStep: 1.0, minQty: 1.0, qtyPrecision: 0 };
    const factor = 1 / inst.qtyStep;
    let qty = Math.floor(rawQty * factor) / factor;
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

// ==========================================
// 3. Replicator Engine Instance
// ==========================================
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
        this.enableTradeSync    = marketConfig.enableTradeSync === true;
        this.bufferPct          = marketConfig.bufferPct          || 0;
        this.cancelOnStop       = marketConfig.cancelOnStop !== false;
        this.tradeDelayMs       = marketConfig.tradeDelayMs       || 0;

        this.binanceDepth  = { bids: [], asks: [] };
        this.testnetDepth  = { bids: [], asks: [] };
        this.restingBids   = [];    
        this.restingAsks   = [];
        this.syncedTrades  = [];

        this.tradeQueue        = [];
        this.priceLocks        = new Set();
        this.ghostCancelQueue  = new Set();

        this.isCrossing         = false;
        this.isSyncingDelta     = false;
        this.isCancellingGhosts = false;
        this.isAligningLtp      = false;

        this.wsBinanceDepth  = null;
        this.wsBinanceTrades = null;
        this.wsTestnet       = null;
        this.testnetPingInterval = null;

        this.testnetLatency    = 0;
        this.binanceLatency    = 0;
        this.binanceLtp        = "0.0000";
        this.totalSyncAttempts = 0;
        this.successfulSyncs   = 0;
        this.hasLoggedAuthError = false;
    }

    async placeOrder(side, qty, price = null, orderType = 'LIMIT', isTaker = false, _isRetry = false) {
        const userCreds = isTaker ? HARDCODED_CREDENTIALS.user2_taker : HARDCODED_CREDENTIALS.user1_maker;
        const userLabel = isTaker ? 'USER2_TAKER' : 'USER1_MAKER';
        const bufferedPrice = price ? applyBuffer(String(price), side, this.bufferPct, this.symbol) : null;

        const payload = { symbol: this.symbol, side: side.toUpperCase(), quantity: String(qty) };
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
                return this.placeOrder(side, qty, price, orderType, isTaker, true);
            }
        }

        // Auto-retry on insufficient funds: call seed_balance then retry once
        if (!res.ok && !_isRetry && res.data && res.data.code === -2018) {
            log.warn(this.symbol, `[SEED] ${userLabel} insufficient funds — calling seed_balance and retrying...`);
            const seeded = await seedBalance(userCreds);
            if (seeded) {
                log.success(this.symbol, `[SEED] ${userLabel} balance topped up. Retrying order...`);
                return this.placeOrder(side, qty, price, orderType, isTaker, true);
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
            return { success: true, orderId: res.data.orderId || res.data.id, price: bufferedPrice };
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
        const res = await sendSignedRequest(`https://testnet-futures-hpo.dcxstage.com/fapi/v1/order`, 'PUT', payload, HARDCODED_CREDENTIALS.user1_maker);

        if (res.status === 401) this.handleAuthFailure('USER1_MAKER');
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
            log.error(this.symbol, `[MODIFY-FAIL] ID: ${orderId} failed: ${JSON.stringify(res.data || res.error)}`);
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
        return res.ok;
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
                reduceUser(HARDCODED_CREDENTIALS.user1_maker, 'USER1_MAKER'),
                reduceUser(HARDCODED_CREDENTIALS.user2_taker, 'USER2_TAKER')
            ]);
        } catch (err) {
            log.error(this.symbol, `[REDUCE-POS] Exception during position reduction: ${err.message}`);
        } finally {
            this.isReducingPositions = false;
        }
    }

    async cancelOrder(orderId, isTaker = false) {
        const userCreds = isTaker ? HARDCODED_CREDENTIALS.user2_taker : HARDCODED_CREDENTIALS.user1_maker;
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
            log.error(this.symbol, `[CANCEL-FAIL] ID: ${orderId} failed: ${JSON.stringify(res.data || res.error)}`);
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
        return { success: res.ok, isTerminal: res.ok || [400, 401, 404].includes(res.status) };
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
            while (this.ghostCancelQueue.size > 0) {
                const chunk = Array.from(this.ghostCancelQueue).slice(0, 5);
                await Promise.allSettled(chunk.map(async (orderId) => {
                    const res = await this.cancelOrder(orderId);
                    if (res.isTerminal) this.ghostCancelQueue.delete(orderId);
                }));
                await new Promise(r => setTimeout(r, 200));
            }
        } finally { this.isCancellingGhosts = false; }
    }

    async syncGrid(side, sourceLevels) {
        const isBuy         = side === 'BUY';
        const restingOrders = isBuy ? this.restingBids : this.restingAsks;
        const tradeSync     = this.enableTradeSync;

        const targets = sourceLevels.slice(0, this.depthLevels).map(lvl => {
            const rawPrice  = lvl[0];
            const notional  = parseFloat(lvl[0]) * parseFloat(lvl[1]);
            const targetSz  = Math.max(this.minSize, Math.min(this.maxSize, notional));
            const qty       = calculateQty(targetSz, rawPrice, this.symbol);
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

                if (orderStatus === 'PARTIALLY_FILLED') {
                    if (!tradeSync) activePool.push(matched);
                    else {
                        cancelBatch.push(this.cancelOrder(matched.orderId));
                        placeBatch.push(this.placeOrder(side, target.qty, target.rawPrice, 'LIMIT').then(r => r.success && activePool.push({ orderId: r.orderId, price: target.price, qty: target.qty, status: 'NEW' })));
                    }
                } else {
                    const diffPct = Math.abs(parseFloat(matched.qty) - parseFloat(target.qty)) / parseFloat(matched.qty);
                    if (diffPct > this.qtyChangeTolerance) {
                        modifyBatch.push((async () => {
                            const success = await this.modifyMaker(matched.orderId, side, target.rawPrice, target.qty);
                            if (success) { matched.qty = target.qty; activePool.push(matched); } 
                            else {
                                if (tradeSync) {
                                    cancelBatch.push(this.cancelOrder(matched.orderId));
                                    placeBatch.push(this.placeOrder(side, target.qty, target.rawPrice, 'LIMIT').then(r => r.success && activePool.push({ orderId: r.orderId, price: target.price, qty: target.qty, status: 'NEW' })));
                                } else { activePool.push(matched); }
                            }
                        })());
                    } else { activePool.push(matched); }
                }
            }
        }

        for (let i = unmappedTargets.length - 1; i >= 0; i--) {
            const target = unmappedTargets[i];
            if (this.priceLocks.has(target.price)) continue;

            if (unmappedResting.length > 0) {
                const recyclableIdx = unmappedResting.findIndex(ro => (ro.status || 'NEW').toUpperCase() === 'NEW');
                if (recyclableIdx !== -1) {
                    const recycled = unmappedResting[recyclableIdx];
                    unmappedResting.splice(recyclableIdx, 1);
                    modifyBatch.push((async () => {
                        const success = await this.modifyMaker(recycled.orderId, side, target.rawPrice, target.qty);
                        if (success) { recycled.price = target.price; recycled.qty = target.qty; recycled.status = 'NEW'; activePool.push(recycled); } 
                        else {
                            if (tradeSync) {
                                cancelBatch.push(this.cancelOrder(recycled.orderId));
                                placeBatch.push(this.placeOrder(side, target.qty, target.rawPrice, 'LIMIT').then(r => r.success && activePool.push({ orderId: r.orderId, price: target.price, qty: target.qty, status: 'NEW' })));
                            } else { activePool.push(recycled); }
                        }
                    })());
                    unmappedTargets.splice(i, 1);
                    continue;
                }
                if (!tradeSync) { const pf = unmappedResting.pop(); activePool.push(pf); }
            }
            placeBatch.push(this.placeOrder(side, target.qty, target.rawPrice, 'LIMIT').then(r => r.success && activePool.push({ orderId: r.orderId, price: target.price, qty: target.qty, status: 'NEW' })));
            unmappedTargets.splice(i, 1);
        }

        for (const excess of unmappedResting) {
            const orderStatus = (excess.status || 'NEW').toUpperCase();
            if (!tradeSync) activePool.push(excess);
            else { if (orderStatus === 'PARTIALLY_FILLED') cancelBatch.push(this.cancelOrder(excess.orderId)); else activePool.push(excess); }
        }

        await Promise.allSettled([...modifyBatch, ...placeBatch, ...cancelBatch]);
        if (isBuy) this.restingBids = activePool; else this.restingAsks = activePool;
    }

    async refreshRestingStatuses(openOrdersData) {
        if (!Array.isArray(openOrdersData)) return;
        const statusMap = new Map();
        openOrdersData.forEach(o => statusMap.set(o.orderId || o.id, (o.status || 'NEW').toUpperCase()));
        for (const ro of [...this.restingBids, ...this.restingAsks]) {
            if (ro && statusMap.has(ro.orderId)) ro.status = statusMap.get(ro.orderId);
        }
    }

    async runDeltaSync() {
        if (this.status !== 'RUNNING' || this.isSyncingDelta) return;
        this.isSyncingDelta = true;
        this.totalSyncAttempts++;
        const startT = Date.now();

        try {
            const openRes = await sendSignedRequest(`https://testnet-futures-hpo.dcxstage.com/fapi/v1/openOrders`, 'GET', { symbol: this.symbol }, HARDCODED_CREDENTIALS.user1_maker);
            if (openRes.status === 401) { this.handleAuthFailure('USER1_MAKER'); return; }

            if (openRes.ok && Array.isArray(openRes.data)) {
                await this.refreshRestingStatuses(openRes.data);
                const exchangeIds = new Set(openRes.data.map(o => o.orderId || o.id));
                this.restingBids  = this.restingBids.filter(ro => ro && exchangeIds.has(ro.orderId));
                this.restingAsks  = this.restingAsks.filter(ro => ro && exchangeIds.has(ro.orderId));

                const localIds = new Set([...this.restingBids.map(ro => ro.orderId), ...this.restingAsks.map(ro => ro.orderId)]);
                const ghosts = openRes.data.filter(o => !localIds.has(o.orderId || o.id));
                if (ghosts.length > 0) {
                    ghosts.forEach(o => this.ghostCancelQueue.add(o.orderId || o.id));
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
        const pStr      = formatPrice(trade.p, this.symbol);
        const notional  = parseFloat(trade.q) * parseFloat(trade.p);
        const targetSz  = Math.max(this.minSize, Math.min(this.maxSize, notional));
        const scaledQty = calculateQty(targetSz, trade.p, this.symbol);

        const makerSide = trade.m ? 'BUY' : 'SELL';
        const takerSide = trade.m ? 'SELL' : 'BUY';
        this.priceLocks.add(pStr);

        try {
            const restingPool   = makerSide === 'BUY' ? this.restingBids : this.restingAsks;
            const hasRestingMaker = restingPool.find(ro => ro && ro.price === pStr);
            let matched = false;

            if (hasRestingMaker) {
                if (this.tradeDelayMs > 0) await new Promise(r => setTimeout(r, this.tradeDelayMs));
                const takerRes = await this.placeOrder(takerSide, scaledQty, trade.p, 'LIMIT_IOC', true);
                matched = takerRes.success;
                
                emitOrderEvent('order:fill_attempt', {
                    symbol: this.symbol,
                    makerOrderId: hasRestingMaker.orderId,
                    takerOrderId: takerRes.orderId || 'failed_taker',
                    expectedQty: scaledQty,
                    price: trade.p
                });
                
                if (matched) {
                    emitOrderEvent('order:fill_success', {
                        symbol: this.symbol,
                        makerOrderId: hasRestingMaker.orderId,
                        takerOrderId: takerRes.orderId
                    });
                    if (makerSide === 'BUY') this.restingBids = this.restingBids.filter(ro => ro.orderId !== hasRestingMaker.orderId);
                    else this.restingAsks = this.restingAsks.filter(ro => ro.orderId !== hasRestingMaker.orderId);
                } else {
                    emitOrderEvent('order:fill_failed', {
                        symbol: this.symbol,
                        makerOrderId: hasRestingMaker.orderId,
                        error: { msg: 'Taker limit IOC placement failed' }
                    });
                }
            } else {
                const makerRes = await this.placeOrder(makerSide, scaledQty, trade.p, 'LIMIT');
                if (makerRes.success) {
                    if (this.tradeDelayMs > 0) await new Promise(r => setTimeout(r, this.tradeDelayMs));
                    const takerRes = await this.placeOrder(takerSide, scaledQty, trade.p, 'LIMIT_IOC', true);
                    matched = takerRes.success;
                    
                    emitOrderEvent('order:fill_attempt', {
                        symbol: this.symbol,
                        makerOrderId: makerRes.orderId,
                        takerOrderId: takerRes.orderId || 'failed_taker',
                        expectedQty: scaledQty,
                        price: trade.p
                    });
                    
                    if (matched) {
                        emitOrderEvent('order:fill_success', {
                            symbol: this.symbol,
                            makerOrderId: makerRes.orderId,
                            takerOrderId: takerRes.orderId
                        });
                    } else {
                        emitOrderEvent('order:fill_failed', {
                            symbol: this.symbol,
                            makerOrderId: makerRes.orderId,
                            error: { msg: 'Taker limit IOC placement failed' }
                        });
                    }

                    await this.cancelOrder(makerRes.orderId);
                }
            }

            this.syncedTrades.unshift({ id: Date.now() + Math.random().toString(), time: getISTTimeString(), price: pStr, binanceQty: trade.q, stageQty: scaledQty, success: matched });
            if (this.syncedTrades.length > 50) this.syncedTrades.pop();

        } finally { this.priceLocks.delete(pStr); }
    }

    async processTradeQueue() {
        if (this.tradeQueue.length > 50) this.tradeQueue.splice(0, this.tradeQueue.length - 20);
        if (this.isCrossing) return;
        this.isCrossing = true;
        while (this.tradeQueue.length > 0) await this.handleTrade(this.tradeQueue.shift());
        this.isCrossing = false;
    }

startBinanceDepthWS() {
        if (this.wsBinanceDepth) return;
        const startTime = Date.now();
        const sym = this.sourceSymbol.toLowerCase(); // Using Source Symbol
        const url = `wss://fstream.binance.com/public/ws/${sym}@depth20@100ms`;

        this.wsBinanceDepth = new WebSocket(url);
        this.wsBinanceDepth.on('open', () => { log.success(this.symbol, 'Binance Depth WS connected.'); this.binanceLatency = Date.now() - startTime; });
        this.wsBinanceDepth.on('message', (raw) => {
            if (this.status === 'STOPPED') return;
            try {
                const data = JSON.parse(raw.toString());
                const bids = data.bids || data.b;
                const asks = data.asks || data.a;
                
                if (bids && asks) {
                    this.binanceDepth.bids = bids.slice(0, this.depthLevels);
                    this.binanceDepth.asks = asks.slice(0, this.depthLevels);
                    this.runDeltaSync();
                }
            } catch (e) {}
        });
        this.wsBinanceDepth.on('error', () => {});
        this.wsBinanceDepth.on('close', () => { this.wsBinanceDepth = null; if (this.status !== 'STOPPED') setTimeout(() => this.startBinanceDepthWS(), 3000); });
    }

    startBinanceTradesWS() {
        if (this.wsBinanceTrades) return;
        const sym = this.sourceSymbol.toLowerCase(); // Using Source Symbol
        const url = `wss://fstream.binance.com/market/ws/${sym}@aggTrade`;

        this.wsBinanceTrades = new WebSocket(url);
        this.wsBinanceTrades.on('open', () => log.success(this.symbol, 'Binance Trades WS connected.'));
        this.wsBinanceTrades.on('message', (raw) => {
            if (this.status === 'STOPPED') return;
            try {
                const data = JSON.parse(raw.toString());
                if (data.e === 'aggTrade') {
                    this.binanceLtp = data.p;
                    if (this.enableTradeSync) {
                        this.tradeQueue.push({ p: data.p, q: data.q, m: data.m });
                        this.processTradeQueue();
                    }
                }
            } catch (e) {}
        });
        this.wsBinanceTrades.on('error', () => {});
        this.wsBinanceTrades.on('close', () => { this.wsBinanceTrades = null; if (this.status !== 'STOPPED') setTimeout(() => this.startBinanceTradesWS(), 3000); });
    }

startTestnetWS() {
        if (this.wsTestnet) return;
        const sym = this.symbol.toLowerCase(); // Target Symbol
        const streamUrl = `wss://testnet-futures-socket-gateway.dcxstage.com/public/ws/${sym}@depth20`;
        this.wsTestnet = new WebSocket(streamUrl);

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
                }
            } catch (e) {}
        });
        this.wsTestnet.on('error', () => {});
        this.wsTestnet.on('close', () => { this.wsTestnet = null; if (this.status !== 'STOPPED') setTimeout(() => this.startTestnetWS(), 3000); });
        this.wsTestnet.on('open', () => { this.testnetPingInterval = setInterval(() => { if (this.wsTestnet && this.wsTestnet.readyState === WebSocket.OPEN) this.wsTestnet.ping(); }, 30000); });
    }

    async wipeOrders() {
        log.info(this.symbol, 'Wiping orders (15s timeout)...');
        const [u1Res, u2Res] = await Promise.all([
            sendSignedRequest(`https://testnet-futures-hpo.dcxstage.com/fapi/v1/openOrders`, 'GET', { symbol: this.symbol }, HARDCODED_CREDENTIALS.user1_maker, 15000),
            sendSignedRequest(`https://testnet-futures-hpo.dcxstage.com/fapi/v1/openOrders`, 'GET', { symbol: this.symbol }, HARDCODED_CREDENTIALS.user2_taker, 15000)
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
            } catch (e) {}
        }
        if (this.wsTestnet) { clearInterval(this.testnetPingInterval); this.wsTestnet.removeAllListeners('close'); this.wsTestnet.close(); this.wsTestnet = null; }
        this.startTestnetWS();
    }

    async start() {
        if (this.status === 'RUNNING') return;
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
        if (this.cancelOnStop) await this.wipeOrders(); else { this.restingBids = []; this.restingAsks = []; }
    }
}

const instances = new Map();

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

    const portfolio = { walletBalance: "0.00", availableBalance: "0.00", unrealizedProfit: "0.00", positions: [], openOrdersCount: 0, error: errorMsg };
    if (accountData) {
        const pAcc = autoParseAccount(accountData);
        portfolio.walletBalance    = pAcc.walletBalance;
        portfolio.availableBalance = pAcc.availableBalance;
        portfolio.unrealizedProfit = pAcc.unrealizedProfit;
    }
    if (positionData) portfolio.positions = autoParsePositions(positionData);
    return portfolio;
}

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
            const [p1, p2] = await Promise.all([
                getUserPortfolio(HARDCODED_CREDENTIALS.user1_maker),
                getUserPortfolio(HARDCODED_CREDENTIALS.user2_taker)
            ]);
            user1Portfolio = p1;
            user2Portfolio = p2;
        }
    } catch (e) {}
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
function buildPayload() {
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
                binanceLatency:  inst.binanceLatency,
                binanceLtp:      inst.binanceLtp,
                syncRatio:       inst.totalSyncAttempts > 0 ? ((inst.successfulSyncs / inst.totalSyncAttempts) * 100).toFixed(1) : '100',
                pricePrecision:  pData.pricePrecision !== undefined ? pData.pricePrecision : 4,
                qtyPrecision:    pData.qtyPrecision !== undefined ? pData.qtyPrecision : 1,
                bufferPct:       inst.bufferPct,
                cancelOnStop:    inst.cancelOnStop,
                tradeDelayMs:    inst.tradeDelayMs,
                enableTradeSync: inst.enableTradeSync
            }
        };
    }
    return JSON.stringify({ instances: activeInstancesMap, user1Portfolio, user2Portfolio });
}

function broadcastToUI() {
    const payload = buildPayload();
    // Push to any connected SSE browser clients
    if (sseClients.length > 0) {
        sseClients.forEach(c => c.write(`data: ${payload}\n\n`));
    }
    // Always write to state file so Jenkins userContent UI can poll it
    writeStateFile(payload);
}

const server = http.createServer(async (req, res) => {
    if (req.url === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        res.write('\n');
        sseClients.push(res);
        res.on('error', () => { sseClients = sseClients.filter(c => c !== res); });
        res.on('close',  () => { sseClients = sseClients.filter(c => c !== res); });
        try {
            const snapshot = buildPayload();
            res.write(`data: ${snapshot}\n\n`);
        } catch (e) {}
        return;
    }

    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const parsed = JSON.parse(body);
                const sym = parsed.symbol ? parsed.symbol.toUpperCase() : null;
                const targetSym = parsed.targetSymbol ? parsed.targetSymbol.toUpperCase() : sym;
                if (!sym) throw new Error("Symbol is required");

                if (req.url === '/api/config') {
                    // This endpoint is now less relevant as config is passed at startup.
                    // Kept for potential future use, but it won't create new instances.
                    const inst = instances.get(targetSym);
                    if (inst) {
                        if (parsed.minSize     !== undefined) inst.minSize     = parseFloat(parsed.minSize);
                        if (parsed.maxSize     !== undefined) inst.maxSize     = parseFloat(parsed.maxSize);
                        if (parsed.depthLevels !== undefined) inst.depthLevels = parseInt(parsed.depthLevels);
                        if (parsed.bufferPct   !== undefined) inst.bufferPct   = parseFloat(parsed.bufferPct);
                        if (parsed.cancelOnStop !== undefined) inst.cancelOnStop = Boolean(parsed.cancelOnStop);
                        if (parsed.tradeDelayMs !== undefined) inst.tradeDelayMs = parseInt(parsed.tradeDelayMs);
                        log.info(targetSym, `Config updated for existing instance.`);
                    }
                } else {
                    const inst = instances.get(targetSym);
                    if (req.url === '/api/engine/start'  && inst) inst.start();
                    else if (req.url === '/api/engine/pause'  && inst) inst.pause();
                    else if (req.url === '/api/engine/stop'   && inst) await inst.stop();
                    else if (req.url === '/api/engine/reload' && inst) inst.reloadDepth();
                }
                res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message }));
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

server.listen(3000, async () => {
    log.success('SYSTEM', '===========================================================');
    log.success('SYSTEM', 'Replicator Active.');
    log.success('SYSTEM', 'UI is available on port 3000.');
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
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Replication Terminal — CoinDCX HPO</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { --bg: #03040a; --panel: #080c14; --border: rgba(255,255,255,0.055); --bid: #10b981; --ask: #f43f5e; --cyan: #06b6d4; --yellow: #eab308; --purple: #a855f7; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body { font-family: 'JetBrains Mono', monospace; background: var(--bg); color: #b8c4d4; font-size: 11px; overflow-x: hidden; }
  ::-webkit-scrollbar { width: 3px; height: 3px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(6,182,212,0.22); border-radius: 99px; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; }
  .panel-accent { border-color: rgba(6,182,212,0.18); }
  .hdr-bar { height: 2px; background: linear-gradient(90deg, #06b6d4, #8b5cf6, #f43f5e, #06b6d4); background-size: 300% 100%; animation: shimmer 5s linear infinite; }
  @keyframes shimmer { to { background-position: -300% 0; } }
  .dot-live   { background: #10b981; box-shadow: 0 0 0 0 rgba(16,185,129,0.7); animation: pulse-g 1.6s ease-out infinite; }
  .dot-paused { background: #eab308; }
  .dot-dead   { background: #f43f5e; }
  @keyframes pulse-g { 70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
  .d-row { display: grid; grid-template-columns: 1fr 1fr 1fr; align-items: center; padding: 2px 10px; position: relative; border-radius: 3px; cursor: default; }
  .d-row:hover { background: rgba(255,255,255,0.03); }
  .d-bar { position: absolute; top:0; bottom:0; opacity:.13; border-radius:3px; pointer-events:none; transition: width .22s ease; }
  .d-bar-r { right:0; left:auto; }
  .d-bar-l { left:0; right:auto; }
  .d-spread { flex-shrink:0; text-align:center; padding:4px 0; font-size:10px; color:#4b5563; border-top:1px solid rgba(255,255,255,0.04); border-bottom:1px solid rgba(255,255,255,0.04); margin:2px 0; letter-spacing:.06em; }
  @keyframes fG { 50% { color: #10b981; } }
  @keyframes fR { 50% { color: #f43f5e; } }
  .fl-g { animation: fG .35s ease; }
  .fl-r { animation: fR .35s ease; }
  @keyframes slideIn { from { opacity:0; transform:translateX(6px); } to { opacity:1; transform:none; } }
  .tr-row { display: grid; grid-template-columns: 75px 1fr 68px 52px; align-items: center; padding: 4px 10px; border-bottom: 1px solid rgba(255,255,255,0.03); border-radius: 3px; font-size: 10px; }
  .tr-row:hover { background: rgba(255,255,255,0.02); }
  .tab { padding: 4px 10px; border-bottom: 2px solid transparent; color: #4b5563; cursor:pointer; transition: all .18s; font-size:10px; }
  .tab.on { border-color: var(--cyan); color: var(--cyan); }
  .sym-tab { padding: 6px 14px; border-radius: 6px; color: #6b7280; font-weight: 600; cursor: pointer; transition: all .2s; }
  .sym-tab.on { background: rgba(6,182,212,.1); color: var(--cyan); border: 1px solid rgba(6,182,212,.2); }
  .badge { font-size:9px; padding:2px 7px; border-radius:99px; font-weight:700; letter-spacing:.05em; }
  .badge-ok   { background:rgba(16,185,129,.12); border:1px solid rgba(16,185,129,.25); color:#34d399; }
  .badge-fail { background:rgba(244,63,94,.12);  border:1px solid rgba(244,63,94,.25);  color:#fb7185; }
  .chip { background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 8px; padding: 6px 12px; transition: border-color .18s, transform .12s; cursor: default; text-align: center; min-width: 80px; }
  .chip:hover { border-color: rgba(6,182,212,.2); transform: translateY(-1px); }
  .chip-label { font-size:9px; color:#4b5563; text-transform:uppercase; letter-spacing:.07em; }
  .chip-val   { font-size:12px; font-weight:700; margin-top:2px; }
  .ticker-card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; flex: 1; }
  .ticker-label { font-size:9px; color:#4b5563; text-transform:uppercase; letter-spacing:.07em; }
  .ticker-val   { font-size:20px; font-weight:700; font-variant-numeric:tabular-nums; margin-top:3px; }
  .ticker-sub   { font-size:9px; color:#374151; margin-top:2px; }
  .hbar { height:2px; border-radius:99px; background:rgba(255,255,255,.06); overflow:hidden; margin-top:6px; }
  .hbar-fill { height:100%; border-radius:99px; transition: width .4s ease, background .3s; }
  #drawer { position: fixed; top:0; right:0; bottom:0; width:300px; z-index:50; background: #0b0f1a; border-left:1px solid var(--border); padding: 20px 16px; overflow-y:auto; transform: translateX(100%); transition: transform .25s ease; }
  #drawer.open { transform: none; }
  #overlay { position:fixed; inset:0; z-index:49; background:rgba(0,0,0,.45); display:none; }
  #overlay.open { display:block; }
  .err-banner { background: rgba(244,63,94,.08); border: 1px solid rgba(244,63,94,.2); color: #fb7185; border-radius: 6px; padding: 6px 10px; font-size: 10px; margin: 8px 12px 0; }
  .book-hdr { display: grid; grid-template-columns: 1fr 1fr 1fr; padding: 4px 10px; font-size: 9px; color: #374151; text-transform: uppercase; letter-spacing:.07em; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .sec-label { font-size:9px; text-transform:uppercase; letter-spacing:.08em; color:#374151; }
  .sec-title { font-size:11px; font-weight:700; color:#e2e8f0; margin-top:1px; }
  .ctrl-btn { padding: 4px 10px; border-radius: 5px; font-weight: 600; cursor: pointer; transition: opacity .2s; border: 1px solid transparent; }
  .ctrl-btn:hover { opacity: 0.8; }
  .btn-start  { background: rgba(16,185,129,.15); color: #34d399; border-color: rgba(16,185,129,.3); }
  .btn-pause  { background: rgba(234,179,8,.15);  color: #fde047; border-color: rgba(234,179,8,.3); }
  .btn-stop   { background: rgba(244,63,94,.15);  color: #fb7185; border-color: rgba(244,63,94,.3); }
  .btn-reload { background: rgba(168,85,247,.15); color: #c084fc; border-color: rgba(168,85,247,.3); }
  #c-status-toast { position: absolute; top: 16px; right: 50%; transform: translateX(50%); background: #1f2937; padding: 8px 16px; border-radius: 8px; border: 1px solid #374151; z-index: 100; font-size: 12px; }
  .tog { position: relative; width: 28px; height: 16px; background: rgba(255,255,255,0.06); border: 1px solid var(--border); border-radius: 99px; cursor: pointer; transition: background .2s; }
  .tog::after { content: ''; position: absolute; top: 1px; left: 1px; width: 12px; height: 12px; border-radius: 50%; background: #4b5563; transition: transform .2s, background .2s; }
  .tog.on { background: rgba(6,182,212,0.15); border-color: rgba(6,182,212,0.3); }
  .tog.on::after { transform: translateX(12px); background: var(--cyan); }
  .flag-pill { font-size:9px; padding:2px 8px; border-radius:99px; font-weight:700; letter-spacing:.04em; }
  .flag-on  { background:rgba(16,185,129,.1);  border:1px solid rgba(16,185,129,.25); color:#34d399; }
  .flag-off { background:rgba(244,63,94,.1);   border:1px solid rgba(244,63,94,.25);  color:#fb7185; }
  .flag-buf { background:rgba(234,179,8,.1);   border:1px solid rgba(234,179,8,.25);  color:#fde047; }
  /* Utility replacements for removed Tailwind CDN */
  .c-emerald { color: #10b981; }
  .c-rose    { color: #f43f5e; }
  .c-yellow  { color: #eab308; }
  .c-yellow4 { color: #facc15; }
  .fw-bold   { font-weight: 700; }
  #splash { position:fixed;inset:0;z-index:999;background:var(--bg);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;transition:opacity .4s; }
  #splash.hidden { opacity:0;pointer-events:none; }
  .splash-dot { width:10px;height:10px;border-radius:50%;background:var(--cyan);animation:pulse-g 1.2s ease-out infinite; }
  #err-splash { position:fixed;inset:0;z-index:998;background:var(--bg);display:none;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#f43f5e;font-size:12px;padding:40px; }
</style>
</head>
<body>

<!-- Loading splash shown until JS initialises -->
<div id="splash">
  <div class="hdr-bar" style="position:fixed;top:0;left:0;right:0;"></div>
  <div class="splash-dot"></div>
  <div style="color:#06b6d4;font-size:11px;letter-spacing:.12em;text-transform:uppercase;font-weight:700;">REPLICATOR UI — CONNECTING</div>
  <div style="color:#374151;font-size:10px;">Establishing SSE stream to server…</div>
</div>
<div id="err-splash"></div>

<div class="hdr-bar"></div>

<header style="background:var(--panel);border-bottom:1px solid var(--border);padding:8px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;position:sticky;top:0;z-index:30;">
  <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
    <div style="position:relative;width:10px;height:10px;"><div id="dot" class="dot-dead" style="width:10px;height:10px;border-radius:50%;position:absolute;"></div></div>
    <div><span style="font-weight:700;color:#f1f5f9;font-size:12px;letter-spacing:.08em;">MULTI-MARKET REPLICATOR</span><span style="color:#374151;font-size:9px;margin-left:8px;letter-spacing:.06em;">v5 · HPO STAGING</span></div>
  </div>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;" id="symbol-tabs"></div>
  <div style="display:flex;gap:8px;align-items:center;">
    <div id="c-status-toast" style="display:none;"></div>
    <div class="chip"><div class="chip-label">Engine</div><div class="chip-val" id="c-eng"><span class="text-rose-500 font-bold">OFFLINE</span></div></div>
    <div class="chip"><div class="chip-label">IST</div><div class="chip-val" id="c-clock" style="color:#4b5563;font-size:10px;">—</div></div>
    <button id="btn-cfg" style="background:rgba(6,182,212,.08);border:1px solid rgba(6,182,212,.18);color:var(--cyan);border-radius:7px;padding:6px 14px;cursor:pointer;font-family:inherit;font-size:10px;font-weight:700;">⚙ ADD MARKET</button>
  </div>
</header>

<div style="padding: 10px 20px; display:flex; justify-content:space-between; align-items:center; background: #06090f; border-bottom: 1px solid var(--border);">
    <div style="display:flex; gap: 8px;">
        <button class="ctrl-btn btn-start"  id="btn-cmd-start">▶ START</button>
        <button class="ctrl-btn btn-pause"  id="btn-cmd-pause">⏸ PAUSE</button>
        <button class="ctrl-btn btn-stop"   id="btn-cmd-stop">⏹ STOP</button>
        <button class="ctrl-btn btn-reload" id="btn-cmd-reload">↻ RELOAD BOOK</button>
    </div>
    <div style="display:flex; gap: 12px; font-size: 10px; align-items:center; flex-wrap:wrap;">
        <div><span style="color:#6b7280">PAIR:</span> <span id="c-pair" class="font-bold text-gray-200">—</span></div>
        <div><span style="color:#6b7280">BINANCE RTT:</span> <span id="c-bping" class="font-bold text-yellow-500">0ms</span></div>
        <div><span style="color:#6b7280">STAGING RTT:</span> <span id="c-sping" class="font-bold text-cyan-500">0ms</span></div>
        <div><span style="color:#6b7280">SYNC:</span> <span id="c-sync" class="font-bold text-emerald-500">100%</span></div>
        <div id="flag-tradeSync" class="flag-pill flag-off">TRADE SYNC</div>
        <div id="flag-cancelStop" class="flag-pill flag-off">CANCEL ON STOP</div>
        <div id="flag-buffer" class="flag-pill flag-buf">BUF 0%</div>
        <div id="flag-delay" class="flag-pill" style="background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.25);color:#c084fc;">DELAY 0ms</div>
    </div>
</div>

<div id="overlay"></div>
<div id="drawer">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
    <span style="font-weight:700;color:#e2e8f0;font-size:12px;letter-spacing:.07em;">ADD / CONFIGURE MARKET</span>
    <button id="btn-close" style="color:#4b5563;font-size:18px;background:none;border:none;cursor:pointer;">×</button>
  </div>
  <div class="panel" style="padding:12px;margin-bottom:12px;">
    <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px;">Market & Sizing</div>
    
    <label style="display:block;color:#6b7280;font-size:10px;margin-bottom:3px;">Source Symbol (Binance)</label>
    <input id="cfg-symbol" placeholder="e.g. BNBUSDT" style="width:100%;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:5px;padding:5px 8px;color:#e2e8f0;font-family:inherit;font-size:11px;margin-bottom:8px;">
    
    <label style="display:block;color:#6b7280;font-size:10px;margin-bottom:3px;">Target Symbol (Testnet - Optional)</label>
    <input id="cfg-target" placeholder="e.g. BNBQAUSDT (leave empty if same)" style="width:100%;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:5px;padding:5px 8px;color:#e2e8f0;font-family:inherit;font-size:11px;margin-bottom:8px;">
    
    <label style="display:block;color:#6b7280;font-size:10px;margin-bottom:3px;">Min Size (USDT)</label>
    <input id="cfg-min" type="number" placeholder="100" style="width:100%;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:5px;padding:5px 8px;color:#e2e8f0;font-family:inherit;font-size:11px;margin-bottom:8px;">
    
    <label style="display:block;color:#6b7280;font-size:10px;margin-bottom:3px;">Max Size (USDT)</label>
    <input id="cfg-max" type="number" placeholder="500" style="width:100%;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:5px;padding:5px 8px;color:#e2e8f0;font-family:inherit;font-size:11px;margin-bottom:8px;">
    
    <label style="display:block;color:#6b7280;font-size:10px;margin-bottom:3px;">Depth Levels</label>
    <input id="cfg-depth" type="number" placeholder="10" style="width:100%;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:5px;padding:5px 8px;color:#e2e8f0;font-family:inherit;font-size:11px;margin-bottom:12px;">
  </div>
  <div class="panel" style="padding:12px;margin-bottom:12px;">
    <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px;">Execution Controls</div>
    <label style="display:block;color:#6b7280;font-size:10px;margin-bottom:3px;">Price Buffer % <span style="color:#4b5563">(0 = disabled)</span></label>
    <input id="cfg-buffer" type="number" step="0.01" placeholder="0.5" style="width:100%;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:5px;padding:5px 8px;color:#e2e8f0;font-family:inherit;font-size:11px;margin-bottom:8px;">
    <label style="display:block;color:#6b7280;font-size:10px;margin-bottom:3px;">Taker Delay ms <span style="color:#4b5563">(0 = immediate)</span></label>
    <input id="cfg-delay" type="number" placeholder="5000" style="width:100%;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:5px;padding:5px 8px;color:#e2e8f0;font-family:inherit;font-size:11px;margin-bottom:8px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;cursor:pointer;" id="tog-cancel-wrap">
      <span style="color:#9ca3af;font-size:10px;">Cancel Orders on Stop</span>
      <div class="tog on" id="tog-cancel-stop"></div>
    </div>
  </div>
  <div class="panel" style="padding:12px;margin-bottom:12px;">
    <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px;">Display</div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <label style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;"><span style="color:#9ca3af;font-size:10px;">Depth Bars</span><div class="tog on" id="tog-bars"></div></label>
      <label style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;"><span style="color:#9ca3af;font-size:10px;">Flash on Price Change</span><div class="tog on" id="tog-flash"></div></label>
    </div>
  </div>
  <button id="btn-apply" style="width:100%;background:rgba(6,182,212,.12);border:1px solid rgba(6,182,212,.25);color:var(--cyan);border-radius:6px;padding:8px;cursor:pointer;font-family:inherit;font-size:10px;font-weight:700;margin-bottom:6px;">MOUNT / UPDATE MARKET</button>
  <div id="cfg-msg" style="font-size:10px;text-align:center;min-height:14px;"></div>
</div>

<div style="display:flex;gap:10px;padding:12px 20px 0;">
  <div class="ticker-card panel-accent"><div class="ticker-label">Binance LTP</div><div class="ticker-val" id="t-bltp" style="color:var(--yellow)">—</div><div class="ticker-sub">Last agg-trade price</div></div>
  <div class="ticker-card"><div class="ticker-label">Stage Mid Price</div><div class="ticker-val" id="t-sltp" style="color:var(--cyan)">—</div><div class="ticker-sub">(Best ask + best bid) ÷ 2</div></div>
  <div class="ticker-card" id="drift-card"><div class="ticker-label">Basis Drift</div><div style="display:flex;align-items:baseline;gap:8px;margin-top:3px;"><div class="ticker-val" id="t-drift" style="font-size:18px;">—</div><div id="t-dpct" style="font-size:11px;color:#6b7280;">—</div></div><div class="hbar"><div class="hbar-fill" id="drift-bar" style="width:0%;background:var(--cyan)"></div></div></div>
  <div class="ticker-card"><div class="ticker-label">Binance Spread</div><div style="display:flex;align-items:baseline;gap:8px;margin-top:3px;"><div class="ticker-val" id="t-bspread" style="font-size:18px;color:var(--purple)">—</div><div id="t-bspct" style="font-size:11px;color:#6b7280;">—</div></div><div class="ticker-sub">Best ask − Best bid</div></div>
</div>

<div style="display:grid;grid-template-columns:1fr 1fr 340px;gap:10px;padding:10px 20px;">
  <div class="panel" style="display:flex;flex-direction:column;height:500px;overflow:hidden;">
    <div style="padding:10px 12px 8px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;"><div><div class="sec-label">Source</div><div class="sec-title" style="color:var(--yellow)">Binance Perpetual</div></div><div id="bin-spread-badge" style="font-size:9px;padding:2px 8px;border-radius:99px;background:rgba(168,85,247,.08);border:1px solid rgba(168,85,247,.18);color:var(--purple);">Spread —</div></div>
    <div class="book-hdr"><span>Price</span><span style="text-align:center;">Size</span><span style="text-align:right;">Total</span></div>
    <div style="flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column-reverse;" id="bin-asks"></div><div class="d-spread" id="bin-spread-mid">Spread —</div><div style="flex:1;min-height:0;overflow-y:auto;" id="bin-bids"></div>
  </div>
  <div class="panel panel-accent" style="display:flex;flex-direction:column;height:500px;overflow:hidden;">
    <div style="padding:10px 12px 8px;border-bottom:1px solid rgba(6,182,212,0.12);display:flex;justify-content:space-between;align-items:center;"><div><div class="sec-label">Target · Testnet WS</div><div class="sec-title" style="color:var(--cyan)">Stage Orderbook</div></div><div id="stage-spread-badge" style="font-size:9px;padding:2px 8px;border-radius:99px;background:rgba(6,182,212,.07);border:1px solid rgba(6,182,212,.15);color:var(--cyan);">Spread —</div></div>
    <div class="book-hdr"><span>Price</span><span style="text-align:center;">Size</span><span style="text-align:right;">Total</span></div>
    <div style="flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column-reverse;" id="stage-asks"></div><div class="d-spread" id="stage-spread-mid">Spread —</div><div style="flex:1;min-height:0;overflow-y:auto;" id="stage-bids"></div>
  </div>
  <div class="panel" style="display:flex;flex-direction:column;height:500px;overflow:hidden;">
    <div style="padding:10px 12px 8px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
      <div><div class="sec-label">Execution Sync</div><div class="sec-title" style="color:var(--purple);">LTP Cross Stream</div></div>
      <div style="display:flex;gap:6px;"><span id="t-trok" class="badge badge-ok">0 OK</span><span id="t-trfail" class="badge badge-fail">0 FAIL</span></div>
    </div>
    <div style="display:flex;border-bottom:1px solid var(--border);padding:0 8px;">
      <button class="tab-btn tab on" data-f="all">All</button>
      <button class="tab-btn tab" data-f="ok">Filled</button>
      <button class="tab-btn tab" data-f="fail">Failed</button>
    </div>
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
window.addEventListener('DOMContentLoaded', () => {
    try {
        let activeTabSymbol = null;
        let cachedInstances = {};
        let cachedGlobalData = null;
        let tradeFilter = 'all';
        let showBars = true;
        let flashOn = true;
        let pPrec = 4, qPrec = 1;
        let prevBinLtp = null;
        let knownTradeIds = new Set();
        let cancelOnStopState = true;

        setInterval(() => {
            const now = new Date();
            const el = document.getElementById('c-clock');
            if (el) el.textContent = now.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' IST';
        }, 1000);

        document.getElementById('btn-cfg').onclick = () => { document.getElementById('drawer').classList.add('open'); document.getElementById('overlay').classList.add('open'); };
        document.getElementById('btn-close').onclick = () => { document.getElementById('drawer').classList.remove('open'); document.getElementById('overlay').classList.remove('open'); };
        document.getElementById('overlay').onclick = () => { document.getElementById('drawer').classList.remove('open'); document.getElementById('overlay').classList.remove('open'); };

        document.getElementById('tog-cancel-wrap').onclick = () => {
            cancelOnStopState = !cancelOnStopState;
            const el = document.getElementById('tog-cancel-stop');
            if (cancelOnStopState) el.classList.add('on'); else el.classList.remove('on');
        };

        function bindTog(id, cb) {
            const el = document.getElementById(id);
            if (!el) return;
            el.onclick = () => { el.classList.toggle('on'); cb(el.classList.contains('on')); };
        }
        bindTog('tog-bars', v => { showBars = v; });
        bindTog('tog-flash', v => { flashOn = v; });

        function showToast(msgStr, isErr = false) {
            const t = document.getElementById('c-status-toast');
            if (!t) return;
            t.style.display = 'block';
            t.style.color = isErr ? '#f43f5e' : '#10b981';
            t.textContent = msgStr;
            setTimeout(() => { t.style.display = 'none'; }, 3000);
        }

        document.getElementById('btn-apply').onclick = async () => {
            const sym = document.getElementById('cfg-symbol').value.trim().toUpperCase();
            const tgt = document.getElementById('cfg-target').value.trim().toUpperCase() || sym;
            const minV = document.getElementById('cfg-min').value;
            const maxV = document.getElementById('cfg-max').value;
            const depV = document.getElementById('cfg-depth').value;
            const bufV = document.getElementById('cfg-buffer').value;
            const delayV = document.getElementById('cfg-delay').value;
            const msg = document.getElementById('cfg-msg');
            msg.textContent = '';

            if (!sym) { msg.style.color='#f43f5e'; msg.textContent='✗ Symbol required'; return; }
            if (minV && maxV && parseFloat(minV) >= parseFloat(maxV)) { msg.style.color='#f43f5e'; msg.textContent='✗ Min must be < Max'; return; }

            const body = { symbol: sym, targetSymbol: tgt, cancelOnStop: cancelOnStopState };
            if (minV) body.minSize = minV;
            if (maxV) body.maxSize = maxV;
            if (depV) body.depthLevels = depV;
            if (bufV) body.bufferPct = bufV;
            if (delayV) body.tradeDelayMs = delayV;

            msg.style.color = '#06b6d4'; msg.textContent = 'Sending...';
            try {
                const r = await fetch('/api/config', { method:'POST', body: JSON.stringify(body), headers:{'Content-Type':'application/json'} });
                const d = await r.json();
                if (d.success) { msg.style.color='#10b981'; msg.textContent='✓ Market Mounted!'; window.selectTab(tgt); }
                else { msg.style.color='#f43f5e'; msg.textContent='✗ ' + d.error; }
            } catch(e) { msg.style.color='#f43f5e'; msg.textContent='✗ Network error'; }
        };

        window.sendEngineCmd = async function(cmd) {
            if (!activeTabSymbol) return showToast("Select a market tab first!", true);
            try {
                const r = await fetch('/api/engine/'+cmd, { method:'POST', body: JSON.stringify({ symbol: activeTabSymbol }), headers:{'Content-Type':'application/json'} });
                if (r.ok) showToast('✓ Command ' + cmd.toUpperCase() + ' sent');
                else showToast('✗ Failed to send command', true);
            } catch(e) { showToast('✗ Network error', true); }
        };

        document.getElementById('btn-cmd-start').onclick = () => window.sendEngineCmd('start');
        document.getElementById('btn-cmd-pause').onclick = () => window.sendEngineCmd('pause');
        document.getElementById('btn-cmd-stop').onclick = () => window.sendEngineCmd('stop');
        document.getElementById('btn-cmd-reload').onclick = () => window.sendEngineCmd('reload');

        const fmt = (v, d) => parseFloat(v||0).toFixed(d);
        function fmtK(v) { const n = parseFloat(v||0); return n >= 1000 ? (n/1000).toFixed(1)+'K' : n.toFixed(0); }
        function flash(el, cls) {
            if (!flashOn || !el) return;
            el.classList.remove('fl-g','fl-r');
            void el.offsetWidth;
            el.classList.add(cls);
            setTimeout(() => el.classList.remove(cls), 350);
        }

        window.selectTab = function(sym) {
            activeTabSymbol = sym;
            tradeFilter = 'all';
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('on'));
            const defaultTab = document.querySelector('.tab-btn[data-f="all"]');
            if (defaultTab) defaultTab.classList.add('on');
            document.getElementById('trade-stream').innerHTML = '<div style="text-align:center;padding:40px 0;color:#374151;font-size:10px;text-transform:uppercase;letter-spacing:.08em;">Loading...</div>';
            knownTradeIds.clear();

            if (cachedInstances && cachedInstances[sym] && cachedGlobalData) {
                renderSymbolData(cachedInstances[sym], cachedGlobalData);
            }
        };

        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.onclick = () => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('on'));
                btn.classList.add('on');
                tradeFilter = btn.getAttribute('data-f');
                document.getElementById('trade-stream').innerHTML = '';
                knownTradeIds.clear();
                if (cachedInstances[activeTabSymbol]) updateTradeStream(cachedInstances[activeTabSymbol].syncedTrades);
            };
        });

        function renderBook(askEl, bidEl, spreadBadgeEl, spreadMidEl, asks, bids) {
            const maxAskQty = (asks||[]).reduce((m,r) => Math.max(m,parseFloat(r[1])), 0.0001);
            const maxBidQty = (bids||[]).reduce((m,r) => Math.max(m,parseFloat(r[1])), 0.0001);

            function row(r, side, maxQ) {
                const pct = Math.min(100,(parseFloat(r[1])/maxQ)*100).toFixed(1);
                const isAsk = side === 'ask';
                const barCol = isAsk ? '#f43f5e' : '#10b981';
                const col = isAsk ? 'var(--ask)' : 'var(--bid)';
                const total = (parseFloat(r[0]) * parseFloat(r[1])).toFixed(0);
                const barHtml = showBars ? '<div class="d-bar d-bar-'+(isAsk?'r':'l')+'" style="background:'+barCol+';width:'+pct+'%"></div>' : '';
                return '<div class="d-row"><span style="color:'+col+';font-weight:600;">'+fmt(r[0],pPrec)+'</span><span style="text-align:center;color:#6b7280;">'+fmt(r[1],qPrec)+'</span><span style="text-align:right;color:#374151;">'+fmtK(total)+'</span>'+barHtml+'</div>';
            }

            askEl.innerHTML = asks && asks.length ? asks.map(r => row(r,'ask',maxAskQty)).join('') : '<div style="text-align:center;padding:16px 0;color:#374151;font-size:10px;">No asks</div>';
            bidEl.innerHTML = bids && bids.length ? bids.map(r => row(r,'bid',maxBidQty)).join('') : '<div style="text-align:center;padding:16px 0;color:#374151;font-size:10px;">No bids</div>';

            if (asks && asks[0] && bids && bids[0]) {
                const bestAsk = parseFloat(asks[0][0]);
                const bestBid = parseFloat(bids[0][0]);
                const spNum = bestAsk - bestBid;
                const sp = spNum.toFixed(pPrec);
                const spp = bestAsk > 0 ? ((spNum/bestAsk)*100).toFixed(3) : "0.000";
                const txt = "Spread " + sp + " (" + spp + "%)";
                if (spreadBadgeEl) spreadBadgeEl.textContent = txt;
                if (spreadMidEl) spreadMidEl.textContent = txt;
            }
        }

        function updateTradeStream(newTrades) {
            const el = document.getElementById('trade-stream');
            if (!newTrades || !newTrades.length) {
                el.innerHTML = '<div style="text-align:center;padding:40px 0;color:#374151;font-size:10px;text-transform:uppercase;letter-spacing:.08em;">Awaiting trades...</div>';
                knownTradeIds.clear();
                return;
            }

            const newItems = newTrades.filter(t => !knownTradeIds.has(t.id));
            if (newItems.length > 0) {
                if (el.innerHTML.includes('Awaiting trades') || el.innerHTML.includes('Loading')) el.innerHTML = '';
                newItems.reverse().forEach(t => {
                    knownTradeIds.add(t.id);
                    if (tradeFilter === 'ok' && !t.success) return;
                    if (tradeFilter === 'fail' && t.success) return;
                    const badge = t.success
                        ? '<span class="badge badge-ok">FILLED</span>'
                        : '<span class="badge badge-fail">FAILED</span>';
                    const temp = document.createElement('div');
                    temp.className = 'tr-row';
                    temp.style.animation = 'slideIn .22s ease';
                    temp.innerHTML = '<span style="color:#4b5563;">'+t.time+'</span><span style="color:var(--yellow);font-weight:600;">'+parseFloat(t.price).toFixed(pPrec)+'</span><span style="color:#6b7280;">'+parseFloat(t.stageQty).toFixed(qPrec)+'</span>'+badge;
                    el.insertBefore(temp, el.firstChild);
                });
                while (el.children.length > 50) el.removeChild(el.lastChild);
            }
        }

        function chipHtml(label, value, color) {
            return '<div class="chip" style="min-width:70px;"><div class="chip-label">'+label+'</div><div class="chip-val" style="color:'+color+';font-size:10px;">'+value+'</div></div>';
        }

        function renderPortfolio(data, errEl, chipsEl, titleEl, bodyEl) {
            if (data.error) { errEl.style.display='block'; errEl.textContent='\u26a0 '+data.error; }
            else { errEl.style.display='none'; }

            const wallet = parseFloat(data.walletBalance||0);
            const avail = parseFloat(data.availableBalance||0);
            const locked = Math.max(0, wallet - avail);
            const pnl = parseFloat(data.unrealizedProfit||0);

            chipsEl.innerHTML =
                chipHtml('Wallet', wallet.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+' U', '#e2e8f0') +
                chipHtml('Available', avail.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+' U', '#10b981') +
                chipHtml('Locked', locked.toFixed(2)+' U', '#f43f5e') +
                chipHtml('PnL', (pnl>=0?'+':'')+pnl.toFixed(2)+' U', pnl>=0?'#10b981':'#f43f5e') +
                chipHtml('Orders', String(data.openOrdersCount||0), 'var(--cyan)');

            const pos = data.positions || [];
            titleEl.textContent = 'Global Portfolio ('+pos.length+')';

            if (!pos.length) {
                bodyEl.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:24px 0;color:#374151;font-size:10px;text-transform:uppercase;">No active positions</td></tr>';
                return;
            }
            bodyEl.innerHTML = pos.map(p => {
                const sideBg = p.side === 'LONG'
                    ? 'background:rgba(16,185,129,.09);border:1px solid rgba(16,185,129,.2);color:#34d399;'
                    : 'background:rgba(244,63,94,.09);border:1px solid rgba(244,63,94,.2);color:#fb7185;';
                const pnlV = parseFloat(p.unrealizedPnL);
                const pnlCol = pnlV >= 0 ? '#34d399' : '#fb7185';
                const pnlSign= pnlV >= 0 ? '+' : '';
                return '<tr style="border-bottom:1px solid rgba(255,255,255,.03);"><td style="padding:7px 14px;"><span style="font-weight:700;color:#e2e8f0;">'+p.symbol+'</span><span style="margin-left:5px;font-size:9px;padding:1px 6px;border-radius:99px;'+sideBg+'">'+p.side+'</span></td><td style="padding:7px 8px;text-align:right;color:#6b7280;">'+p.leverage+'×</td><td style="padding:7px 8px;text-align:right;color:var(--cyan);">'+parseFloat(p.margin).toFixed(2)+'</td><td style="padding:7px 8px;text-align:right;color:#9ca3af;">'+p.size+'</td><td style="padding:7px 8px;text-align:right;font-weight:700;color:'+pnlCol+';">'+pnlSign+pnlV.toFixed(2)+'</td><td style="padding:7px 8px;text-align:right;color:#6b7280;">'+p.entryPrice+'</td><td style="padding:7px 8px;text-align:right;color:#6b7280;">'+p.markPrice+'</td><td style="padding:7px 14px;text-align:right;color:var(--yellow);">'+p.liqPrice+'</td></tr>';
            }).join('');
        }

        function renderSymbolData(instance, data) {
            const diag = instance.diagnostics || {};
            pPrec = diag.pricePrecision !== undefined ? diag.pricePrecision : 4;
            qPrec = diag.qtyPrecision !== undefined ? diag.qtyPrecision : 1;

            const dot = document.getElementById('dot');
            const statusTxt = document.getElementById('c-eng');
            if (instance.status === 'RUNNING') { dot.className = 'dot-live'; statusTxt.innerHTML = "<span class='c-emerald fw-bold'>RUNNING</span>"; }
            else if (instance.status === 'PAUSED') { dot.className = 'dot-paused'; statusTxt.innerHTML = "<span class='c-yellow fw-bold'>PAUSED</span>"; }
            else { dot.className = 'dot-dead'; statusTxt.innerHTML = "<span class='c-rose fw-bold'>STOPPED</span>"; }

            document.getElementById('c-bping').textContent = (diag.binanceLatency||0) + 'ms';
            document.getElementById('c-sping').textContent = (diag.testnetLatency||0) + 'ms';
            document.getElementById('c-sync').textContent = (diag.syncRatio||'100') + '%';
            
            const srcStr = (diag.sourceSymbol && diag.sourceSymbol !== activeTabSymbol) ? ' (SRC: ' + diag.sourceSymbol + ')' : '';
            document.getElementById('c-pair').textContent = activeTabSymbol + srcStr;

            const tsEl = document.getElementById('flag-tradeSync');
            const csEl = document.getElementById('flag-cancelStop');
            const bufEl = document.getElementById('flag-buffer');
            const delEl = document.getElementById('flag-delay');

            if (diag.enableTradeSync) { tsEl.textContent='TRADE SYNC ON'; tsEl.className='flag-pill flag-on'; }
            else { tsEl.textContent='TRADE SYNC OFF'; tsEl.className='flag-pill flag-off'; }

            if (diag.cancelOnStop) { csEl.textContent='CANCEL ON STOP'; csEl.className='flag-pill flag-on'; }
            else { csEl.textContent='KEEP ON STOP'; csEl.className='flag-pill flag-off'; }

            const buf = parseFloat(diag.bufferPct||0);
            bufEl.textContent = buf > 0 ? 'BUF '+buf+'%' : 'NO BUFFER';

            const delay = parseInt(diag.tradeDelayMs||0);
            delEl.textContent = delay > 0 ? 'DELAY '+delay+'ms' : 'DELAY OFF';

            const binLtp = diag.binanceLtp || '0.0000';
            const ltpEl = document.getElementById('t-bltp');
            if (prevBinLtp !== null && flashOn) {
                const d = parseFloat(binLtp) - parseFloat(prevBinLtp);
                if (d > 0) flash(ltpEl, 'fl-g');
                else if (d < 0) flash(ltpEl, 'fl-r');
            }
            prevBinLtp = binLtp;
            ltpEl.textContent = fmt(binLtp, pPrec);

            const sa = instance.testnetDepth.asks, sb = instance.testnetDepth.bids;
            const stageLtp = (sa&&sa[0]&&sb&&sb[0]) ? ((parseFloat(sa[0][0])+parseFloat(sb[0][0]))/2).toFixed(pPrec) : binLtp;
            document.getElementById('t-sltp').textContent = fmt(stageLtp, pPrec);

            const dAbs = Math.abs(parseFloat(binLtp)-parseFloat(stageLtp)).toFixed(pPrec);
            const dPct = parseFloat(binLtp)>0 ? ((dAbs/parseFloat(binLtp))*100).toFixed(3) : '0.000';
            const dp = parseFloat(dPct);
            document.getElementById('t-drift').textContent = dAbs;
            document.getElementById('t-dpct').textContent = '('+dPct+'%)';
            const driftBar = document.getElementById('drift-bar');
            driftBar.style.width = Math.min(100, dp*1000)+'%';
            driftBar.style.background = dp>0.05 ? '#f43f5e' : dp>0.02 ? '#eab308' : 'var(--cyan)';

            const ba = instance.binanceDepth.asks, bb = instance.binanceDepth.bids;
            if (ba&&ba[0]&&bb&&bb[0]) {
                const spNum = parseFloat(ba[0][0]) - parseFloat(bb[0][0]);
                const sp = spNum.toFixed(pPrec);
                const spp = parseFloat(ba[0][0]) > 0 ? ((spNum/parseFloat(ba[0][0]))*100).toFixed(3) : "0.000";
                document.getElementById('t-bspread').textContent = sp;
                document.getElementById('t-bspct').textContent = '('+spp+'%)';
            }

            const ok = (instance.syncedTrades||[]).filter(t => t.success).length;
            const fail = (instance.syncedTrades||[]).filter(t => !t.success).length;
            document.getElementById('t-trok').textContent = ok + ' OK';
            document.getElementById('t-trfail').textContent = fail + ' FAIL';

            renderBook(document.getElementById('bin-asks'), document.getElementById('bin-bids'), document.getElementById('bin-spread-badge'), document.getElementById('bin-spread-mid'), instance.binanceDepth.asks, instance.binanceDepth.bids);
            renderBook(document.getElementById('stage-asks'), document.getElementById('stage-bids'), document.getElementById('stage-spread-badge'), document.getElementById('stage-spread-mid'), instance.testnetDepth.asks, instance.testnetDepth.bids);

            updateTradeStream(instance.syncedTrades);
            renderPortfolio(data.user1Portfolio, document.getElementById('u1-err'), document.getElementById('u1-chips'), document.getElementById('u1-title'), document.getElementById('u1-body'));
            renderPortfolio(data.user2Portfolio, document.getElementById('u2-err'), document.getElementById('u2-chips'), document.getElementById('u2-title'), document.getElementById('u2-body'));
        }

        let es;
        function connectSSE() {
            if (es) es.close();
            es = new EventSource('/events');

            es.onopen = () => {
                knownTradeIds.clear();
                prevBinLtp = null;
                // Hide splash once connected
                const sp = document.getElementById('splash');
                if (sp) { sp.classList.add('hidden'); setTimeout(()=>sp.remove(),500); }
                document.getElementById('dot').className = 'dot-live';
                document.getElementById('c-eng').innerHTML = "<span class='c-yellow4 fw-bold'>CONNECTING...</span>";
            };

            es.onerror = () => {
                document.getElementById('dot').className = 'dot-dead';
                document.getElementById('c-eng').innerHTML = "<span class='c-rose fw-bold'>DISCONNECTED</span>";
                es.close();
                setTimeout(connectSSE, 2500); // auto-reconnect
            };

            es.onmessage = (ev) => {
                let data;
                try { data = JSON.parse(ev.data); } catch(e) { return; }

                cachedInstances = data.instances || {};
                cachedGlobalData = data;

                const tabContainer = document.getElementById('symbol-tabs');
                const symbols = Object.keys(cachedInstances);

                if (symbols.length === 0) {
                    tabContainer.innerHTML = '<span style="color:#374151;font-size:10px;letter-spacing:.06em;">Waiting for engine...</span>';
                    document.getElementById('c-eng').innerHTML = "<span class='c-yellow4 fw-bold'>BOOTING...</span>";
                    return;
                }

                if (!activeTabSymbol || !cachedInstances[activeTabSymbol]) window.selectTab(symbols[0]);

                tabContainer.innerHTML = symbols.map(sym => {
                    const isActive = sym === activeTabSymbol;
                    const statColor = cachedInstances[sym].status === 'RUNNING' ? '#10b981' : cachedInstances[sym].status === 'PAUSED' ? '#eab308' : '#f43f5e';
                    return '<div class="sym-tab '+(isActive?'on':'')+'" onclick="window.selectTab(\\''+sym+'\\')"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:'+statColor+';margin-right:6px;"></span>'+sym+'</div>';
                }).join('');

                if (activeTabSymbol && cachedInstances[activeTabSymbol]) {
                    renderSymbolData(cachedInstances[activeTabSymbol], data);
                }
            };
        }

        connectSSE();

    } catch (e) {
        console.error("FATAL UI INITIALIZATION ERROR: ", e);
        const errDiv = document.getElementById('err-splash');
        if (errDiv) {
            errDiv.style.display = 'flex';
            errDiv.innerHTML = '<div style="font-size:16px;font-weight:700;">⚠ UI Initialization Error</div><div style="color:#9ca3af;text-align:center;max-width:600px;word-break:break-all;">' + (e && e.message ? e.message : String(e)) + '</div><div style="color:#374151;font-size:10px;">Check browser console (F12) for details.</div>';
        }
        const sp = document.getElementById('splash');
        if (sp) sp.classList.add('hidden');
    }
});
</script>
</body>
</html>`;
}