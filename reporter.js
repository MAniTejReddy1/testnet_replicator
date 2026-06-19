/**
 * reporter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * QA Aggregate Reporter for the CoinDCX Testnet Replicator.
 *
 * HOW IT WORKS
 *   1. Receives events from replicator.js via HTTP POST on /event
 *   2. Tracks counters for every order lifecycle action:
 *      - Maker orders placed (success/fail + reasons)
 *      - Taker orders placed (success/fail + reasons)
 *      - Orders cancelled (attempted/success/fail)
 *      - Orders modified  (attempted/success/fail)
 *      - Orders filled    (matched/failed)
 *   3. On shutdown (SIGTERM/SIGINT) or --flush, writes clean Allure summary
 *      test cases with assertions showing pass/fail counts
 *
 * START
 *   node reporter.js          ← normal mode (listens forever)
 *   node reporter.js --flush  ← flush-only mode (called from Jenkins post)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const http   = require('http');

var uuidv4;
if (crypto.randomUUID) {
    uuidv4 = crypto.randomUUID.bind(crypto);
} else {
    uuidv4 = function() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = crypto.randomBytes(1)[0] % 16;
            var v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1.  CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
var RESULTS_DIR  = path.resolve(__dirname, 'allure-results');
var FLUSH_FLAG   = process.argv.includes('--flush');
var COUNTERS_FILE = path.resolve(__dirname, 'allure-results', '.counters.json');

var log = function(tag, msg) {
    console.log('[\\x1b[36mREPORTER\\x1b[0m][\\x1b[33m' + tag + '\\x1b[0m] ' + msg);
};

// ─────────────────────────────────────────────────────────────────────────────
// 2.  COUNTERS — track everything in memory, flush to Allure at the end
// ─────────────────────────────────────────────────────────────────────────────
var counters = {
    makerPlace:   { success: 0, fail: 0, failReasons: {} },
    takerPlace:   { success: 0, fail: 0, failReasons: {} },
    cancel:       { attempted: 0, success: 0, fail: 0, failReasons: {} },
    modify:       { attempted: 0, success: 0, fail: 0, failReasons: {} },
    fill:         { matched: 0, failed: 0, failReasons: {} },
    seedBalance:  { triggered: 0, success: 0, fail: 0 },
    errors:       []  // recent error samples (capped at 50)
};

function addFailReason(bucket, reason) {
    if (!reason) reason = 'Unknown';
    bucket[reason] = (bucket[reason] || 0) + 1;
}

function addError(msg) {
    if (counters.errors.length < 50) {
        counters.errors.push({ time: new Date().toISOString(), msg: msg });
    }
}

// Save counters to disk periodically so --flush can read them
function persistCounters() {
    try {
        fs.writeFileSync(COUNTERS_FILE, JSON.stringify(counters, null, 2), 'utf8');
    } catch(e) {}
}

function loadCounters() {
    try {
        if (fs.existsSync(COUNTERS_FILE)) {
            var data = JSON.parse(fs.readFileSync(COUNTERS_FILE, 'utf8'));
            counters = data;
            log('INIT', 'Loaded existing counters from disk.');
        }
    } catch(e) {
        log('WARN', 'Could not load counters: ' + e.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3.  EVENT HANDLERS
// ─────────────────────────────────────────────────────────────────────────────
function handleEvent(evt) {
    var type = evt.type;

    switch (type) {
        case 'order:placed':
            if (evt.isTaker) {
                counters.takerPlace.success++;
            } else {
                counters.makerPlace.success++;
            }
            break;

        case 'order:place_failed':
            var reason = (evt.error && evt.error.msg) || (evt.error && evt.error.message) || evt.reason || 'Unknown';
            var code = (evt.error && evt.error.code) || '';
            var fullReason = code ? (code + ': ' + reason) : reason;
            if (evt.isTaker) {
                counters.takerPlace.fail++;
                addFailReason(counters.takerPlace.failReasons, fullReason);
            } else {
                counters.makerPlace.fail++;
                addFailReason(counters.makerPlace.failReasons, fullReason);
            }
            addError('[PLACE_FAIL] ' + (evt.isTaker ? 'TAKER' : 'MAKER') + ' ' + fullReason);
            break;

        case 'order:cancelled':
            counters.cancel.attempted++;
            counters.cancel.success++;
            break;

        case 'order:cancel_failed':
            counters.cancel.attempted++;
            counters.cancel.fail++;
            var cancelReason = (evt.error && evt.error.msg) || evt.reason || 'Unknown';
            addFailReason(counters.cancel.failReasons, cancelReason);
            addError('[CANCEL_FAIL] ' + cancelReason);
            break;

        case 'order:modified':
            counters.modify.attempted++;
            counters.modify.success++;
            break;

        case 'order:modify_failed':
            counters.modify.attempted++;
            counters.modify.fail++;
            var modReason = (evt.error && evt.error.msg) || evt.reason || 'Unknown';
            addFailReason(counters.modify.failReasons, modReason);
            addError('[MODIFY_FAIL] ' + modReason);
            break;

        case 'order:fill_success':
            counters.fill.matched++;
            break;

        case 'order:fill_failed':
            counters.fill.failed++;
            var fillReason = (evt.error && evt.error.msg) || evt.reason || 'Unknown';
            addFailReason(counters.fill.failReasons, fillReason);
            addError('[FILL_FAIL] ' + fillReason);
            break;

        case 'seed:triggered':
            counters.seedBalance.triggered++;
            break;

        case 'seed:success':
            counters.seedBalance.success++;
            break;

        case 'seed:failed':
            counters.seedBalance.fail++;
            break;

        default:
            log('WARN', 'Unknown event type: ' + type);
    }

    // Persist counters every 20 events
    var total = counters.makerPlace.success + counters.makerPlace.fail +
                counters.takerPlace.success + counters.takerPlace.fail +
                counters.cancel.attempted + counters.modify.attempted + counters.fill.matched;
    if (total % 20 === 0) {
        persistCounters();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4.  ALLURE RESULT BUILDER (Simplified)
// ─────────────────────────────────────────────────────────────────────────────
function createAllureResult(name, feature, story, severity) {
    return {
        uuid:        uuidv4(),
        historyId:   feature + ':' + story + ':' + name,
        testCaseId:  feature + ':' + story + ':' + name,
        fullName:    feature + ': ' + name,
        name:        name,
        status:      'passed',
        start:       Date.now(),
        stop:        null,
        steps:       [],
        attachments: [],
        labels: [
            { name: 'feature',  value: feature },
            { name: 'story',    value: story },
            { name: 'severity', value: severity || 'normal' },
            { name: 'suite',    value: 'Replicator Summary' },
        ],
        parameters:  [],
        statusDetails: {}
    };
}

function addStep(result, name, passed, message) {
    var step = {
        name: name,
        status: passed ? 'passed' : 'failed',
        start: Date.now(),
        stop: Date.now(),
        steps: [],
        attachments: [],
        statusDetails: passed ? {} : { message: message || '' }
    };
    result.steps.push(step);
    if (!passed) {
        result.status = 'failed';
        result.statusDetails = { message: message || name + ' failed' };
    }
    return step;
}

function addParam(result, name, value) {
    result.parameters.push({ name: name, value: String(value) });
}

function writeResult(result) {
    result.stop = Date.now();
    var filename = result.uuid + '-result.json';
    fs.writeFileSync(
        path.join(RESULTS_DIR, filename),
        JSON.stringify(result, null, 2),
        'utf8'
    );
    log('RESULT', result.status.toUpperCase() + ' ' + result.name + ' → ' + filename);
}

function formatReasons(reasons) {
    var entries = Object.entries(reasons);
    if (entries.length === 0) return 'None';
    return entries.map(function(e) { return e[0] + ' (x' + e[1] + ')'; }).join(', ');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5.  FLUSH SUMMARY — generates clean Allure test cases from counters
// ─────────────────────────────────────────────────────────────────────────────
function flushSummaryTests() {
    log('FLUSH', '═══════════════════════════════════════════════');
    log('FLUSH', '  Generating Allure summary test cases...');
    log('FLUSH', '═══════════════════════════════════════════════');

    // ── 1. Maker Orders Placed ──
    var makerResult = createAllureResult(
        'Maker Orders Placed',
        'Order Placement',
        'Maker',
        'critical'
    );
    addParam(makerResult, 'Total Attempted', counters.makerPlace.success + counters.makerPlace.fail);
    addParam(makerResult, 'Successful', counters.makerPlace.success);
    addParam(makerResult, 'Failed', counters.makerPlace.fail);
    addParam(makerResult, 'Failure Reasons', formatReasons(counters.makerPlace.failReasons));

    addStep(makerResult, 'Maker orders placed: ' + counters.makerPlace.success + ' successful', true);
    if (counters.makerPlace.fail > 0) {
        addStep(makerResult, 'Maker orders failed: ' + counters.makerPlace.fail + ' — ' + formatReasons(counters.makerPlace.failReasons), false, 
            counters.makerPlace.fail + ' maker orders failed. Reasons: ' + formatReasons(counters.makerPlace.failReasons));
    } else {
        addStep(makerResult, 'No maker order failures', true);
    }
    writeResult(makerResult);

    // ── 2. Taker Orders Placed ──
    var takerResult = createAllureResult(
        'Taker Orders Placed',
        'Order Placement',
        'Taker',
        'critical'
    );
    addParam(takerResult, 'Total Attempted', counters.takerPlace.success + counters.takerPlace.fail);
    addParam(takerResult, 'Successful', counters.takerPlace.success);
    addParam(takerResult, 'Failed', counters.takerPlace.fail);
    addParam(takerResult, 'Failure Reasons', formatReasons(counters.takerPlace.failReasons));

    addStep(takerResult, 'Taker orders placed: ' + counters.takerPlace.success + ' successful', true);
    if (counters.takerPlace.fail > 0) {
        addStep(takerResult, 'Taker orders failed: ' + counters.takerPlace.fail + ' — ' + formatReasons(counters.takerPlace.failReasons), false,
            counters.takerPlace.fail + ' taker orders failed. Reasons: ' + formatReasons(counters.takerPlace.failReasons));
    } else {
        addStep(takerResult, 'No taker order failures', true);
    }
    writeResult(takerResult);

    // ── 3. Order Cancellations ──
    var cancelResult = createAllureResult(
        'Order Cancellations',
        'Order Lifecycle',
        'Cancel',
        'normal'
    );
    addParam(cancelResult, 'Total Attempted', counters.cancel.attempted);
    addParam(cancelResult, 'Successful', counters.cancel.success);
    addParam(cancelResult, 'Failed', counters.cancel.fail);
    addParam(cancelResult, 'Failure Reasons', formatReasons(counters.cancel.failReasons));

    addStep(cancelResult, 'Cancellations attempted: ' + counters.cancel.attempted, true);
    addStep(cancelResult, 'Cancellations successful: ' + counters.cancel.success, true);
    if (counters.cancel.fail > 0) {
        addStep(cancelResult, 'Cancellations failed: ' + counters.cancel.fail + ' — ' + formatReasons(counters.cancel.failReasons), false,
            counters.cancel.fail + ' cancellations failed. Reasons: ' + formatReasons(counters.cancel.failReasons));
    } else {
        addStep(cancelResult, 'No cancellation failures', true);
    }
    writeResult(cancelResult);

    // ── 4. Order Modifications ──
    var modifyResult = createAllureResult(
        'Order Modifications',
        'Order Lifecycle',
        'Modify',
        'normal'
    );
    addParam(modifyResult, 'Total Attempted', counters.modify.attempted);
    addParam(modifyResult, 'Successful', counters.modify.success);
    addParam(modifyResult, 'Failed', counters.modify.fail);
    addParam(modifyResult, 'Failure Reasons', formatReasons(counters.modify.failReasons));

    addStep(modifyResult, 'Modifications attempted: ' + counters.modify.attempted, true);
    addStep(modifyResult, 'Modifications successful: ' + counters.modify.success, true);
    if (counters.modify.fail > 0) {
        addStep(modifyResult, 'Modifications failed: ' + counters.modify.fail + ' — ' + formatReasons(counters.modify.failReasons), false,
            counters.modify.fail + ' modifications failed. Reasons: ' + formatReasons(counters.modify.failReasons));
    } else {
        addStep(modifyResult, 'No modification failures', true);
    }
    writeResult(modifyResult);

    // ── 5. Order Fills / Matches ──
    var fillResult = createAllureResult(
        'Order Fills',
        'Order Lifecycle',
        'Fill / Match',
        'critical'
    );
    addParam(fillResult, 'Matched Successfully', counters.fill.matched);
    addParam(fillResult, 'Failed', counters.fill.failed);
    addParam(fillResult, 'Failure Reasons', formatReasons(counters.fill.failReasons));

    addStep(fillResult, 'Orders matched/filled: ' + counters.fill.matched, true);
    if (counters.fill.failed > 0) {
        addStep(fillResult, 'Fills failed: ' + counters.fill.failed + ' — ' + formatReasons(counters.fill.failReasons), false,
            counters.fill.failed + ' fills failed. Reasons: ' + formatReasons(counters.fill.failReasons));
    } else {
        addStep(fillResult, 'No fill failures', true);
    }
    writeResult(fillResult);

    // ── 6. Seed Balance (auto top-up) ──
    var seedResult = createAllureResult(
        'Seed Balance (Auto Top-up)',
        'Infrastructure',
        'Seed Balance',
        'minor'
    );
    addParam(seedResult, 'Triggered', counters.seedBalance.triggered);
    addParam(seedResult, 'Successful', counters.seedBalance.success);
    addParam(seedResult, 'Failed', counters.seedBalance.fail);

    if (counters.seedBalance.triggered > 0) {
        addStep(seedResult, 'Seed balance triggered: ' + counters.seedBalance.triggered + ' times', true);
        addStep(seedResult, 'Successful: ' + counters.seedBalance.success, counters.seedBalance.success > 0);
        if (counters.seedBalance.fail > 0) {
            addStep(seedResult, 'Failed: ' + counters.seedBalance.fail, false, 
                counters.seedBalance.fail + ' seed_balance calls failed');
        }
    } else {
        addStep(seedResult, 'No seed_balance calls needed during this run', true);
    }
    writeResult(seedResult);

    // ── 7. Overall Summary ──
    var totalPlaced = counters.makerPlace.success + counters.takerPlace.success;
    var totalPlaceFail = counters.makerPlace.fail + counters.takerPlace.fail;
    var summaryResult = createAllureResult(
        'Overall Run Summary',
        'Summary',
        'Run Totals',
        'blocker'
    );
    addParam(summaryResult, 'Maker Orders OK', counters.makerPlace.success);
    addParam(summaryResult, 'Maker Orders FAIL', counters.makerPlace.fail);
    addParam(summaryResult, 'Taker Orders OK', counters.takerPlace.success);
    addParam(summaryResult, 'Taker Orders FAIL', counters.takerPlace.fail);
    addParam(summaryResult, 'Cancel OK', counters.cancel.success);
    addParam(summaryResult, 'Cancel FAIL', counters.cancel.fail);
    addParam(summaryResult, 'Modify OK', counters.modify.success);
    addParam(summaryResult, 'Modify FAIL', counters.modify.fail);
    addParam(summaryResult, 'Fills Matched', counters.fill.matched);
    addParam(summaryResult, 'Fills FAIL', counters.fill.failed);

    addStep(summaryResult, 'Total orders placed successfully: ' + totalPlaced, totalPlaced > 0, 
        totalPlaced === 0 ? 'No orders were placed successfully during this run' : '');
    addStep(summaryResult, 'Total order placement failures: ' + totalPlaceFail, totalPlaceFail === 0,
        totalPlaceFail > 0 ? totalPlaceFail + ' order placements failed' : '');
    addStep(summaryResult, 'Total cancellations: ' + counters.cancel.success + '/' + counters.cancel.attempted + ' successful', 
        counters.cancel.fail === 0, counters.cancel.fail > 0 ? counters.cancel.fail + ' cancellations failed' : '');
    addStep(summaryResult, 'Total modifications: ' + counters.modify.success + '/' + counters.modify.attempted + ' successful',
        counters.modify.fail === 0, counters.modify.fail > 0 ? counters.modify.fail + ' modifications failed' : '');
    addStep(summaryResult, 'Total fills matched: ' + counters.fill.matched,
        counters.fill.failed === 0, counters.fill.failed > 0 ? counters.fill.failed + ' fills failed' : '');

    // Attach error log if there are any
    if (counters.errors.length > 0) {
        var errorFilename = uuidv4() + '-attachment.json';
        fs.writeFileSync(
            path.join(RESULTS_DIR, errorFilename),
            JSON.stringify(counters.errors, null, 2),
            'utf8'
        );
        summaryResult.attachments.push({
            name: 'Error Log (last ' + counters.errors.length + ' errors)',
            type: 'application/json',
            source: errorFilename
        });
    }

    writeResult(summaryResult);

    log('FLUSH', '═══════════════════════════════════════════════');
    log('FLUSH', '  Summary: ' + totalPlaced + ' placed, ' + totalPlaceFail + ' failed, ' +
        counters.cancel.success + ' cancelled, ' + counters.modify.success + ' modified, ' +
        counters.fill.matched + ' matched');
    log('FLUSH', '═══════════════════════════════════════════════');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6.  HTTP RECEIVER
// ─────────────────────────────────────────────────────────────────────────────
function startHttpReceiver() {
    var PORT = process.env.REPORTER_PORT || 3001;
    var srv  = http.createServer(function(req, res) {
        if (req.method !== 'POST' || req.url !== '/event') {
            res.writeHead(404);
            res.end();
            return;
        }
        var body = '';
        req.on('data', function(c) { body += c; });
        req.on('end', function() {
            try {
                var evt = JSON.parse(body);
                handleEvent(evt);
                res.writeHead(202);
                res.end('{"ok":true}');
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    });
    srv.listen(PORT, function() {
        log('INIT', 'HTTP receiver listening on port ' + PORT);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 7.  ALLURE METADATA FILES
// ─────────────────────────────────────────────────────────────────────────────
function writeEnvironment() {
    var configs = 'unknown';
    try {
        if (process.env.MARKET_CONFIGS) {
            configs = JSON.parse(process.env.MARKET_CONFIGS).map(function(m) { return m.sourceSymbol; }).join(', ');
        }
    } catch(e) {}
    var lines = [
        'BASE_URL=https://testnet-futures-hpo.dcxstage.com',
        'SYMBOLS=' + configs,
        'STARTED=' + new Date().toISOString(),
        'NODE_VERSION=' + process.version,
    ];
    fs.writeFileSync(path.join(RESULTS_DIR, 'environment.properties'), lines.join('\n'), 'utf8');
    log('INIT', 'environment.properties written');
}

function writeCategoriesAndExecutor() {
    var categories = [
        {
            name: 'Order Failures',
            matchedStatuses: ['failed'],
            messageRegex: '.*failed.*',
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

    var executor = {
        name: 'Jenkins',
        type: 'jenkins',
        url: process.env.BUILD_URL || 'http://localhost:8080',
        buildOrder: process.env.BUILD_NUMBER ? parseInt(process.env.BUILD_NUMBER) : 1,
        buildName: process.env.JOB_NAME || 'local-run',
        reportUrl: (process.env.BUILD_URL || '') + 'allure/',
    };
    fs.writeFileSync(
        path.join(RESULTS_DIR, 'executor.json'),
        JSON.stringify(executor, null, 2),
        'utf8'
    );
    log('INIT', 'categories.json and executor.json written');
}

// ─────────────────────────────────────────────────────────────────────────────
// 8.  MAIN
// ─────────────────────────────────────────────────────────────────────────────
function main() {
    // Ensure results directory exists
    fs.mkdirSync(RESULTS_DIR, { recursive: true });

    if (FLUSH_FLAG) {
        log('FLUSH', 'Flush mode — loading counters and generating summary.');
        loadCounters();
        writeEnvironment();
        writeCategoriesAndExecutor();
        flushSummaryTests();
        process.exit(0);
    }

    log('INIT', '════════════════════════════════════════════════');
    log('INIT', ' QA Aggregate Reporter starting...');
    log('INIT', '════════════════════════════════════════════════');

    writeEnvironment();
    writeCategoriesAndExecutor();

    // Start HTTP receiver
    startHttpReceiver();

    log('INIT', 'Reporter ready. Waiting for order events...');
}

// Graceful shutdown
process.on('SIGINT', function() {
    log('SHUTDOWN', 'SIGINT received — persisting counters...');
    persistCounters();
    log('SHUTDOWN', 'Counters persisted. Run --flush to generate report.');
    process.exit(0);
});

process.on('SIGTERM', function() {
    log('SHUTDOWN', 'SIGTERM received — persisting counters...');
    persistCounters();
    log('SHUTDOWN', 'Counters persisted. Run --flush to generate report.');
    process.exit(0);
});

main();