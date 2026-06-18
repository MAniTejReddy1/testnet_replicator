const EventEmitter = require('events');
global.replicatorBus = new EventEmitter();
global.replicatorBus.setMaxListeners(100);

// Helper to fire events to the reporter (works whether reporter runs
// in-process via wireEventBus() or out-of-process via HTTP)
const REPORTER_URL = `http://localhost:${process.env.REPORTER_PORT || 3001}/event`;

async function emitOrderEvent(type, payload) {
  // In-process bus (if reporter.js is required in same process)
  if (global.replicatorBus) {
    global.replicatorBus.emit(type, { type, ...payload });
  }
  // Out-of-process HTTP (if reporter runs as separate Node process)
  try {
    await fetch(REPORTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, ...payload }),
    }).catch(() => {}); // silently ignore — reporter being down must not break replicator
  } catch {}
}
/**
 * reporter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * QA Order-Lifecycle Reporter for the CoinDCX Testnet Replicator.
 *
 * HOW IT WORKS
 *   1. Listens to global.replicatorBus events emitted by replicator.js
 *   2. For every placed / cancelled / filled order it runs 6-checkpoint
 *      lifecycle validations against the testnet REST API
 *   3. Writes Allure-compatible JSON result files to ./allure-results/
 *   4. On SIGINT (Jenkins abort) or --flush flag, flushes all in-flight
 *      results to disk so Jenkins can pick them up in the post block
 *
 * START
 *   node reporter.js          ← normal mode (listens forever)
 *   node reporter.js --flush  ← flush-only mode (called from Jenkins post)
 *
 * REQUIRES
 *   replicator.js must expose:
 *     global.replicatorBus   EventEmitter
 *     HARDCODED_CREDENTIALS  (imported via require)
 *   npm install node-fetch abort-controller uuid
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const http         = require('http');

let uuidv4;
if (crypto.randomUUID) {
    uuidv4 = crypto.randomUUID.bind(crypto);
} else {
    uuidv4 = () => {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = crypto.randomBytes(1)[0] % 16;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    };
}

// ─── Dynamic import shim for node-fetch v2 (commonjs) ───────────────────────
let fetch, AbortController;
try {
    fetch         = require('node-fetch');
    AbortController = require('abort-controller');
} catch (e) {
    console.error('[REPORTER] FATAL: node-fetch or abort-controller not installed.');
    console.error('           Run: npm install node-fetch@2 abort-controller uuid');
    process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1.  CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
const BASE_URL     = 'https://testnet-futures-hpo.dcxstage.com';
const RESULTS_DIR  = path.resolve(__dirname, 'allure-results');
const FLUSH_FLAG   = process.argv.includes('--flush');

// SLAs in milliseconds — assertions will FAIL if breached
const SLA = {
    orderInBook:       500,   // order visible in depth after POST
    cancelFromBook:    500,   // order removed from depth after DELETE
    fillInGetOrder:   1000,   // GET /order shows FILLED after taker hits
    tradeRecord:      2000,   // trade record available after fill
    positionUpdate:   2000,   // positionRisk updated after fill
    balanceUpdate:    3000,   // account balance updated after fill
    restCallP95:       500,   // any single signed REST call
};

// Poll intervals / retries
const POLL_INTERVAL_MS  = 200;
const FILL_POLL_TIMEOUT = 10000;   // 10s max to wait for fill
const DEPTH_POLL_TRIES  = 5;

// Credentials — same as replicator.js (hardcoded for CI)
const CREDS = {
    user1: {
        key:    'b417fbd0627044f0e0066a7bd9de3fbe1e8b024ec8c70077',
        secret: '02cb3e25d1e13f03ee8f4ffc784e2db86e2c45883f157575a9c913fee6aed5cf',
        label:  'USER1_MAKER',
    },
    user2: {
        key:    '249f18188c6020f36f79834b0f8cc83e7e749d43c519ce04',
        secret: '1fce044918e10a8c93cc02645f0d68022a20322f200c44b208639c3ccba9f41e',
        label:  'USER2_TAKER',
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// 2.  ALLURE RESULT BUILDER
// ─────────────────────────────────────────────────────────────────────────────
class AllureResult {
    constructor({ name, feature, story, severity = 'critical', labels = {} }) {
        this.uuid        = uuidv4();
        this.historyId   = `${feature}:${story}:${name}`;
        this.testCaseId  = this.historyId;
        this.fullName    = `${feature}: ${name}`;
        this.name        = name;
        this.status      = 'passed';
        this.start       = Date.now();
        this.stop        = null;
        this.steps       = [];
        this.attachments = [];
        this.labels      = [
            { name: 'feature',  value: feature  },
            { name: 'story',    value: story     },
            { name: 'severity', value: severity  },
            ...Object.entries(labels).map(([n, v]) => ({ name: n, value: String(v) })),
        ];
        this.parameters  = [];
        this._currentStep = null;
    }

    /** Start a named step — returns the step object so you can mutate it */
    step(name) {
        const s = {
            name,
            status:      'passed',
            start:       Date.now(),
            stop:        null,
            steps:       [],
            attachments: [],
            statusDetails: {},
        };
        this.steps.push(s);
        this._currentStep = s;
        return s;
    }

    /** Close the current step with pass/fail and optional message */
    endStep(pass, message = '') {
        const s = this._currentStep;
        if (!s) return;
        s.stop   = Date.now();
        s.status = pass ? 'passed' : 'failed';
        if (!pass) {
            s.statusDetails = { message };
            this.status     = 'failed';
        }
        this._currentStep = null;
        return s;
    }

    /** Attach a JSON blob to the most recent step (or the result itself) */
    attachJson(name, obj) {
        const filename = `${uuidv4()}-attachment.json`;
        const content  = JSON.stringify(obj, null, 2);
        fs.writeFileSync(path.join(RESULTS_DIR, filename), content, 'utf8');
        const att = { name, type: 'application/json', source: filename };
        if (this._currentStep) this._currentStep.attachments.push(att);
        else                    this.attachments.push(att);
    }

    /** Add a parameter (shown in Allure parameter tab) */
    param(name, value) {
        this.parameters.push({ name, value: String(value) });
        return this;
    }

    /** Mark as broken (system error, not assertion failure) */
    broken(message) {
        this.status = 'broken';
        this.statusDetails = { message };
        if (this._currentStep) {
            this._currentStep.status = 'broken';
            this._currentStep.statusDetails = { message };
        }
        return this;
    }

    /** Write the result JSON to allure-results/ */
    flush() {
        this.stop = Date.now();
        const filename = `${this.uuid}-result.json`;
        fs.writeFileSync(
            path.join(RESULTS_DIR, filename),
            JSON.stringify(this, null, 2),
            'utf8'
        );
        log('RESULT', `${this.status.toUpperCase().padEnd(6)} ${this.name} → ${filename}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3.  SIGNED REST CLIENT
// ─────────────────────────────────────────────────────────────────────────────
let serverTimeOffset = 0;

function sign(secret, payload) {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Make a signed REST call and return { ok, status, data, latencyMs }.
 * All GET/DELETE params go on the query string; POST/PUT go in the JSON body.
 */
async function call(method, endpoint, params = {}, creds = CREDS.user1, timeoutMs = 8000) {
    const t0        = Date.now();
    const timestamp = t0 + serverTimeOffset;
    const isWrite   = ['POST', 'PUT'].includes(method.toUpperCase());

    const url = new URL(`${BASE_URL}${endpoint}`);
    let bodyStr = null;
    let signPayload = ''; // Initialize signPayload

    if (isWrite) {
        const body = { ...params, timestamp };
        bodyStr    = JSON.stringify(body);
        signPayload = bodyStr; // For POST/PUT, sign the JSON body
    } else {
        // For GET/DELETE, parameters are in the query string.
        // The FAPI server expects the full query string to be signed.
        // Construct the query string explicitly for signing and for the URL.
        const queryParams = { ...params, timestamp };
        const sortedQueryParams = Object.keys(queryParams).sort().map(key => {
            return `${key}=${queryParams[key]}`;
        }).join('&');

        url.search = sortedQueryParams ? `?${sortedQueryParams}` : ''; // Set the full query string for the fetch call
        signPayload = sortedQueryParams; // Sign the constructed query string
    }

    const sig = sign(creds.secret, signPayload); // Use the explicitly constructed signPayload
    const headers = {
        'Content-Type':    'application/json',
        'X-AUTH-APIKEY':   creds.key,
        'X-AUTH-SIGNATURE': sig,
    };

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res  = await fetch(url.toString(), {
            method:  method.toUpperCase(),
            headers,
            body:    bodyStr || undefined,
            signal:  controller.signal,
        });
        clearTimeout(timer);
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }
        return { ok: res.ok, status: res.status, data, latencyMs: Date.now() - t0 };
    } catch (err) {
        clearTimeout(timer);
        return { ok: false, status: err.name === 'AbortError' ? 408 : 500,
            data: { error: err.message }, latencyMs: Date.now() - t0 };
    }
}

/** Unauthenticated call (depth, trades, exchangeInfo) */
async function publicCall(endpoint, params = {}) {
    const t0  = Date.now();
    const url = new URL(`${BASE_URL}${endpoint}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    try {
        const res  = await fetch(url.toString());
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }
        return { ok: res.ok, status: res.status, data, latencyMs: Date.now() - t0 };
    } catch (err) {
        return { ok: false, status: 500, data: { error: err.message }, latencyMs: Date.now() - t0 };
    }
}

async function syncTime() {
    try {
        const r = await publicCall('/fapi/v1/time');
        if (r.ok && r.data.serverTime) {
            serverTimeOffset = r.data.serverTime - Date.now();
            log('INIT', `Server time synced. Offset: ${serverTimeOffset}ms`);
        }
    } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// 4.  PRIMITIVE HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const log = (tag, msg) =>
    console.log(`[\x1b[36mREPORTER\x1b[0m][\x1b[33m${tag}\x1b[0m] ${msg}`);

function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * Poll fn() every POLL_INTERVAL_MS until predicate(result) is true or timeout.
 * Returns { result, elapsed, timedOut }.
 */
async function pollUntil(fn, predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const result = await fn();
        if (predicate(result)) return { result, elapsed: Date.now() - (deadline - timeoutMs), timedOut: false };
        await wait(POLL_INTERVAL_MS);
    }
    const result = await fn();
    return { result, elapsed: timeoutMs, timedOut: !predicate(result) };
}

/** Find orderId in depth book on correct side. Returns { found, levelQty, latencyMs } */
async function findInDepth(symbol, side, price, limit = 50) {
    const t0  = Date.now();
    const res = await publicCall('/fapi/v1/depth', { symbol, limit });
    if (!res.ok) return { found: false, levelQty: 0, latencyMs: Date.now() - t0, raw: res.data };
    const levels = side.toUpperCase() === 'BUY' ? (res.data.bids || []) : (res.data.asks || []);
    const row    = levels.find(l => parseFloat(l[0]) === parseFloat(price));
    return { found: !!row, levelQty: row ? parseFloat(row[1]) : 0, latencyMs: Date.now() - t0, raw: res.data };
}

function assertSla(result, description, latency, sla) {
    const pass = latency <= sla;
    const message = `${description} (${latency}ms / ${sla}ms)`;
    result.endStep(pass, pass ? message : `SLA BREACH: ${message}`);
    return pass;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5.  LIFECYCLE VALIDATORS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PLACE VALIDATOR
 * Runs after every successful POST /fapi/v1/order.
 */
async function validatePlace({ symbol, side, qty, price, orderId, isTaker, orderType, t0 }) {
    const result = new AllureResult({
        name: `[${side}] ${qty} @ ${price}`,
        feature: `Place Order (${symbol})`,
        story: isTaker ? 'Taker' : 'Maker',
    });
    result.param('symbol', symbol).param('side', side).param('qty', qty).param('price', price).param('orderId', orderId);

    const creds = isTaker ? CREDS.user2 : CREDS.user1;

    try {
        if (orderType !== 'LIMIT_IOC') {
            // 1. Check if order appears in depth book
            result.step(`Check order book for ${orderId}`);
            const { result: depth, timedOut } = await pollUntil(
                () => findInDepth(symbol, side, price),
                (r) => r.found,
                SLA.orderInBook * DEPTH_POLL_TRIES
            );
            result.attachJson('Depth API Response', depth.raw);
            if (timedOut) {
                result.endStep(false, `Order ${orderId} not found in depth book after ${SLA.orderInBook * DEPTH_POLL_TRIES}ms`);
            } else {
                assertSla(result, 'Order visible in book', depth.latencyMs, SLA.orderInBook);
            }
        }

        // 2. Check GET /order
        result.step(`GET /order for ${orderId}`);
        const getOrderRes = await call('GET', '/fapi/v1/order', { symbol, orderId }, creds);
        result.attachJson('GET /order Response', getOrderRes.data);
        assertSla(result, 'GET /order response time', getOrderRes.latencyMs, SLA.restCallP95);
        if (!getOrderRes.ok || String(getOrderRes.data.orderId) !== String(orderId)) {
            result.endStep(false, `GET /order failed or returned wrong order. Status: ${getOrderRes.status}`);
        } else {
            result.endStep(true, `Status: ${getOrderRes.data.status}`);
        }

        if (orderType !== 'LIMIT_IOC') {
            // 3. Check openOrders
            result.step(`Check open orders for ${orderId}`);
            const openOrdersRes = await call('GET', '/fapi/v1/openOrders', { symbol }, creds);
            result.attachJson('GET /openOrders Response', openOrdersRes.data);
            assertSla(result, 'GET /openOrders response time', openOrdersRes.latencyMs, SLA.restCallP95);
            const foundInOpen = Array.isArray(openOrdersRes.data) && openOrdersRes.data.some(o => String(o.orderId) === String(orderId));
            result.endStep(foundInOpen, foundInOpen ? 'Found in open orders' : 'Not found in open orders');
        }

    } catch (e) {
        result.broken(`Unhandled exception: ${e.message}`);
        log('ERROR', `validatePlace threw: ${e.stack}`);
    } finally {
        result.flush();
    }
}

/**
 * CANCEL VALIDATOR
 * Runs after every successful DELETE /fapi/v1/order.
 */
async function validateCancel({ symbol, orderId, price, side, isTaker }) {
     const result = new AllureResult({
        name: `Cancel ${orderId}`,
        feature: `Cancel Order (${symbol})`,
        story: isTaker ? 'Taker' : 'Maker',
    });
    result.param('symbol', symbol).param('orderId', orderId);

    const creds = isTaker ? CREDS.user2 : CREDS.user1;

    try {
        // 1. Check if order is removed from depth book
        if (price && side && !isTaker) {
            result.step(`Check order book for ${orderId} removal`);
            const { result: depth, timedOut } = await pollUntil(
                () => findInDepth(symbol, side, price),
                (r) => !r.found,
                SLA.cancelFromBook * DEPTH_POLL_TRIES
            );
            result.attachJson('Depth API Response', depth.raw);
            if (timedOut) {
                result.endStep(true, `Warning: Price level ${price} still exists (could be external orders or leftover volume)`);
            } else {
                assertSla(result, 'Order removed from book', depth.latencyMs, SLA.cancelFromBook);
            }
        }

        // 2. Check GET /order status is CANCELED
        result.step(`GET /order for ${orderId}`);
        const getOrderRes = await call('GET', '/fapi/v1/order', { symbol, orderId }, creds);
        result.attachJson('GET /order Response', getOrderRes.data);
        assertSla(result, 'GET /order response time', getOrderRes.latencyMs, SLA.restCallP95);
        if (!getOrderRes.ok || getOrderRes.data.status !== 'CANCELED') {
            result.endStep(false, `GET /order status is not CANCELED. Status: ${getOrderRes.data.status || getOrderRes.status}`);
        } else {
            result.endStep(true, 'Status: CANCELED');
        }

    } catch (e) {
        result.broken(`Unhandled exception: ${e.message}`);
        log('ERROR', `validateCancel threw: ${e.stack}`);
    } finally {
        result.flush();
    }
}

/**
 * FILL VALIDATOR
 */
async function validateFill({ symbol, makerOrderId, takerOrderId, expectedQty, price }) {
    const result = new AllureResult({
        name: `Fill ${makerOrderId}`,
        feature: `Fill Order (${symbol})`,
        story: 'Taker vs Maker',
    });
    result.param('symbol', symbol).param('makerOrderId', makerOrderId).param('takerOrderId', takerOrderId).param('price', price);

    try {
        // 1. Poll GET /order until maker order is FILLED
        result.step(`Poll GET /order for maker ${makerOrderId} to be FILLED`);
        const { result: getOrder, timedOut, elapsed } = await pollUntil(
            () => call('GET', '/fapi/v1/order', { symbol, orderId: makerOrderId }),
            (r) => r.ok && r.data.status === 'FILLED',
            FILL_POLL_TIMEOUT
        );
        result.attachJson('Final GET /order Response', getOrder.data);
        if (timedOut) {
            result.endStep(false, `Maker order ${makerOrderId} not FILLED after ${FILL_POLL_TIMEOUT}ms. Final status: ${getOrder.data.status}`);
            result.flush();
            return;
        }
        assertSla(result, 'Maker order FILLED', elapsed, SLA.fillInGetOrder);

        // 2. Check user trades for maker
        result.step(`Check user trades for maker ${makerOrderId}`);
        const tradesRes = await call('GET', '/fapi/v1/userTrades', { symbol });
        result.attachJson('Maker /userTrades Response', tradesRes.data);
        assertSla(result, '/userTrades response time', tradesRes.latencyMs, SLA.tradeRecord);
        const trade = Array.isArray(tradesRes.data) && tradesRes.data.find(t => String(t.orderId) === String(makerOrderId));
        if (!trade) {
            result.endStep(false, `Trade for maker order ${makerOrderId} not found in /userTrades`);
        } else {
            result.endStep(true, `Trade found. Qty: ${trade.qty}`);
        }

        // 3. Check position risk for maker
        result.step(`Check position risk for maker`);
        const posRes = await call('GET', '/fapi/v1/positionRisk');
        result.attachJson('Maker /positionRisk Response', posRes.data);
        assertSla(result, '/positionRisk response time', posRes.latencyMs, SLA.positionUpdate);
        const position = Array.isArray(posRes.data) && posRes.data.find(p => p.symbol === symbol);
        if (!position) {
            result.endStep(false, `Position for ${symbol} not found`);
        } else {
            result.endStep(true, `Position amount: ${position.positionAmt}`);
        }

        if (takerOrderId) {
            // 4. Check user trades for taker
            result.step(`Check user trades for taker ${takerOrderId}`);
            const takerTradesRes = await call('GET', '/fapi/v1/userTrades', { symbol }, CREDS.user2);
            result.attachJson('Taker /userTrades Response', takerTradesRes.data);
            assertSla(result, 'Taker /userTrades response time', takerTradesRes.latencyMs, SLA.tradeRecord);
            const takerTrade = Array.isArray(takerTradesRes.data) && takerTradesRes.data.find(t => String(t.orderId) === String(takerOrderId));
            if (!takerTrade) {
                result.endStep(false, `Trade for taker order ${takerOrderId} not found in /userTrades`);
            } else {
                result.endStep(true, `Trade found. Qty: ${takerTrade.qty}`);
            }

            // 5. Check position risk for taker
            result.step(`Check position risk for taker`);
            const takerPosRes = await call('GET', '/fapi/v1/positionRisk', {}, CREDS.user2);
            result.attachJson('Taker /positionRisk Response', takerPosRes.data);
            assertSla(result, 'Taker /positionRisk response time', takerPosRes.latencyMs, SLA.positionUpdate);
            const takerPosition = Array.isArray(takerPosRes.data) && takerPosRes.data.find(p => p.symbol === symbol);
            if (!takerPosition) {
                result.endStep(false, `Taker Position for ${symbol} not found`);
            } else {
                result.endStep(true, `Taker Position amount: ${takerPosition.positionAmt}`);
            }
        }

    } catch (e) {
        result.broken(`Unhandled exception: ${e.message}`);
        log('ERROR', `validateFill threw: ${e.stack}`);
    } finally {
        result.flush();
    }
}

/**
 * MODIFY VALIDATOR
 */
async function validateModify({ symbol, orderId, side, newPrice, newQty }) {
    const result = new AllureResult({
        name: `Modify ${orderId} to ${newQty}@${newPrice}`,
        feature: `Modify Order (${symbol})`,
        story: 'Maker',
    });
    result.param('symbol', symbol).param('orderId', orderId).param('newPrice', newPrice).param('newQty', newQty);

    try {
        result.step(`Check order book for modified order ${orderId}`);
        const { result: depth, timedOut } = await pollUntil(
            () => findInDepth(symbol, side, newPrice),
            (r) => r.found && r.levelQty >= parseFloat(newQty),
            SLA.orderInBook * DEPTH_POLL_TRIES
        );
        result.attachJson('Depth API Response', depth.raw);
        if (timedOut) {
            result.endStep(false, `Modified order ${orderId} not found at new price/qty after ${SLA.orderInBook * DEPTH_POLL_TRIES}ms`);
        } else {
            assertSla(result, 'Order visible in book at new price/qty', depth.latencyMs, SLA.orderInBook);
        }
    } catch (e) {
        result.broken(`Unhandled exception: ${e.message}`);
        log('ERROR', `validateModify threw: ${e.stack}`);
    } finally {
        result.flush();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7.  EVENT BUS WIRING
//     Connects to global.replicatorBus (set in replicator.js)
// ─────────────────────────────────────────────────────────────────────────────
function wireEventBus() {
    const bus = global.replicatorBus;
    if (!bus) {
        log('WARN', 'global.replicatorBus not found — running in standalone mode (HTTP events only)');
        return;
    }

    log('INIT', 'Connected to replicatorBus');

    bus.on('order:placed', async (evt) => {
        log('EVENT', `order:placed  ${evt.symbol} ${evt.side} ${evt.qty}@${evt.price} id=${evt.orderId}`);
        await validatePlace(evt).catch(e => log('ERROR', `validatePlace threw: ${e.message}`));
    });

    bus.on('order:cancelled', async (evt) => {
        log('EVENT', `order:cancelled ${evt.symbol} id=${evt.orderId}`);
        await validateCancel(evt).catch(e => log('ERROR', `validateCancel threw: ${e.message}`));
    });

    bus.on('order:fill_attempt', async (evt) => {
        log('EVENT', `order:fill_attempt ${evt.symbol} maker=${evt.makerOrderId} taker=${evt.takerOrderId}`);
        await validateFill(evt).catch(e => log('ERROR', `validateFill threw: ${e.message}`));
    });

    bus.on('order:modified', async (evt) => {
        log('EVENT', `order:modified ${evt.symbol} id=${evt.orderId} → price=${evt.newPrice}`);
        await validateModify(evt).catch(e => log('ERROR', `validateModify threw: ${e.message}`));
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 8.  HTTP RECEIVER (alternative to bus — post events from replicator via HTTP)
//     POST http://localhost:3001/event  { type, ...payload }
// ─────────────────────────────────────────────────────────────────────────────
function startHttpReceiver() {
    const PORT = process.env.REPORTER_PORT || 3001;
    const srv  = http.createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/event') {
            res.writeHead(404).end();
            return;
        }
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const evt = JSON.parse(body);
                switch (evt.type) {
                    case 'order:placed':       await validatePlace(evt);   break;
                    case 'order:cancelled':    await validateCancel(evt);  break;
                    case 'order:fill_attempt': await validateFill(evt);    break;
                    case 'order:modified':     await validateModify(evt);  break;
                    default:
                        log('WARN', `Unknown event type: ${evt.type}`);
                }
                res.writeHead(202).end('{"ok":true}');
            } catch (e) {
                res.writeHead(400).end(JSON.stringify({ error: e.message }));
            }
        });
    });
    srv.listen(PORT, () => log('INIT', `HTTP receiver listening on port ${PORT}`));
}

// ─────────────────────────────────────────────────────────────────────────────
// 9.  ALLURE METADATA FILES
// ─────────────────────────────────────────────────────────────────────────────
function writeEnvironment() {
    const configs = process.env.MARKET_CONFIGS
        ? JSON.parse(process.env.MARKET_CONFIGS).map(m => m.sourceSymbol).join(', ')
        : 'unknown';
    const lines = [
        `BASE_URL=${BASE_URL}`,
        `SYMBOLS=${configs}`,
        `STARTED=${new Date().toISOString()}`,
        `NODE_VERSION=${process.version}`,
        `SLA_ORDER_IN_BOOK_MS=${SLA.orderInBook}`,
        `SLA_FILL_IN_GET_ORDER_MS=${SLA.fillInGetOrder}`,
        `SLA_TRADE_RECORD_MS=${SLA.tradeRecord}`,
        `SLA_POSITION_UPDATE_MS=${SLA.positionUpdate}`,
        `SLA_BALANCE_UPDATE_MS=${SLA.balanceUpdate}`,
    ];
    fs.writeFileSync(path.join(RESULTS_DIR, 'environment.properties'), lines.join('\n'), 'utf8');
    log('INIT', 'environment.properties written');
}

function writeCategoriesAndExecutor() {
    const categories = [
        {
            name: 'SLA Breaches',
            matchedStatuses: ['failed'],
            messageRegex: '.*SLA.*',
        },
        {
            name: 'Infrastructure Errors',
            matchedStatuses: ['broken'],
        },
    ];
    fs.writeFileSync(
        path.join(RESULTS_DIR, 'categories.json'),
        JSON.stringify(categories, null, 2),
        'utf8'
    );

    const executor = {
        name: 'Jenkins',
        type: 'jenkins',
        url: process.env.BUILD_URL || 'http://localhost:8080',
        buildOrder: process.env.BUILD_NUMBER ? parseInt(process.env.BUILD_NUMBER) : 1,
        buildName: process.env.JOB_NAME || 'local-run',
        reportUrl: `${process.env.BUILD_URL}allure/`,
    };
    fs.writeFileSync(
        path.join(RESULTS_DIR, 'executor.json'),
        JSON.stringify(executor, null, 2),
        'utf8'
    );
    log('INIT', 'categories.json and executor.json written');
}


// ─────────────────────────────────────────────────────────────────────────────
// 10. MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
    // Ensure results directory exists
    fs.mkdirSync(RESULTS_DIR, { recursive: true });

    if (FLUSH_FLAG) {
        log('FLUSH', 'Flush mode — writing metadata and exiting.');
        writeEnvironment();
        writeCategoriesAndExecutor();
        process.exit(0);
    }

    log('INIT', '════════════════════════════════════════════════');
    log('INIT', ' QA Order-Lifecycle Reporter starting...');
    log('INIT', '════════════════════════════════════════════════');

    await syncTime();
    writeEnvironment();
    writeCategoriesAndExecutor();

    // Wire to replicatorBus if running inside same process
    wireEventBus();

    // Start HTTP receiver for out-of-process mode (replicator → reporter via localhost)
    startHttpReceiver();

    log('INIT', 'Reporter ready. Waiting for order events...');
}

// Graceful shutdown — ensure all pending results are flushed
process.on('SIGINT', async () => {
    log('SHUTDOWN', 'SIGINT received — flushing results...');
    await wait(2000); // give any in-flight validations time to complete
    log('SHUTDOWN', `Results written to ${RESULTS_DIR}`);
    process.exit(0);
});

process.on('SIGTERM', async () => {
    log('SHUTDOWN', 'SIGTERM received — flushing results...');
    await wait(2000);
    process.exit(0);
});

main().catch(err => {
    log('FATAL', err.message);
    process.exit(1);
});