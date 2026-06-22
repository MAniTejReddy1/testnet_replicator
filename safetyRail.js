// safetyRail.js

/**
 * Hard constraints for the Scenario Engine to prevent accidental production 
 * damage or matching engine crashes due to extreme illiquidity or massive price spikes.
 */

const MAX_PCT_CAP = parseFloat(process.env.FLASH_MAX_PCT || "0.50"); // Max 50% movement
const COOLDOWN_MS = parseInt(process.env.FLASH_COOLDOWN_MS || "5000", 10);
const ALLOWED_SYMBOLS = (process.env.FLASH_ALLOWED_SYMBOLS || "BTCUSDT,ETHUSDT").split(',');

const lastTriggerTime = new Map();

function validateScenarioRequest(symbol, payload) {
    if (!symbol) throw new Error("Symbol is required");

    // Validate symbol whitelist
    if (!ALLOWED_SYMBOLS.includes(symbol)) {
        throw new Error(`Symbol ${symbol} is not in the allowed QA testing whitelist (${ALLOWED_SYMBOLS.join(', ')})`);
    }

    // Cooldown check
    const now = Date.now();
    const last = lastTriggerTime.get(symbol) || 0;
    if (now - last < COOLDOWN_MS) {
        throw new Error(`Cooldown active for ${symbol}. Please wait ${COOLDOWN_MS - (now - last)}ms.`);
    }

    // PCT Limit Check
    if (payload.pct !== undefined) {
        if (Math.abs(payload.pct) > MAX_PCT_CAP) {
            throw new Error(`Requested price shift ${payload.pct * 100}% exceeds the hard safety cap of ±${MAX_PCT_CAP * 100}%`);
        }
    }

    // If using steps, validate each step
    if (Array.isArray(payload.steps)) {
        for (const step of payload.steps) {
            if (step.pct !== undefined && Math.abs(step.pct) > MAX_PCT_CAP) {
                throw new Error(`Step price shift ${step.pct * 100}% exceeds the hard safety cap of ±${MAX_PCT_CAP * 100}%`);
            }
        }
    }

    // Mark cooldown
    lastTriggerTime.set(symbol, now);
    return true;
}

function clearCooldown(symbol) {
    lastTriggerTime.delete(symbol);
}

module.exports = {
    validateScenarioRequest,
    clearCooldown,
    MAX_PCT_CAP
};
