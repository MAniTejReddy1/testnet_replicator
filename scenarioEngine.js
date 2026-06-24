const { validateScenarioRequest } = require('./safetyRail');

const activeScenarios = new Map();

class ScenarioEngine {
    /**
     * Gets the current transformer configuration for the given symbol.
     * Called by replicator.js Maker and Taker on every tick.
     */
    static getTransformer(symbol) {
        const state = activeScenarios.get(symbol);
        if (!state || state.phase === 'IDLE') return { multiplier: 1.0 };
        return {
            multiplier: state.currentMultiplier,
            spreadBias: state.config.spreadBias,
            targetSpreadPct: state.config.targetSpreadPct,
            depthSkew: state.config.depthSkew,
            profileSkew: state.config.profileSkew,
            jitterPct: state.config.jitterPct
        };
    }

    /**
     * Triggers a new scenario. Validates the payload via safetyRail first.
     */
    static startScenario(symbol, config, currentLtp = null) {
        if (config.targetPrice && currentLtp) {
            config.pct = (parseFloat(config.targetPrice) - parseFloat(currentLtp)) / parseFloat(currentLtp);
        }
        
        validateScenarioRequest(symbol, config);
        
        const state = {
            phase: 'RAMPING',
            mode: config.targetQty ? 'CONDITION_SEEKING' : 'DETERMINISTIC',
            config,
            startTime: Date.now(),
            phaseStartTime: Date.now(),
            accumulatedQty: 0,
            currentMultiplier: 1.0,
            targetMultiplier: 1.0 + (config.pct || 0),
            pingPongCycle: 0
        };
        activeScenarios.set(symbol, state);
        console.log(`[SCENARIO] 🟢 Started ${state.mode} scenario for ${symbol}. Target Pct: ${config.pct}`);
        return state;
    }

    static abortScenario(symbol) {
        if (activeScenarios.has(symbol)) {
            activeScenarios.delete(symbol);
            console.log(`[SCENARIO] 🛑 Aborted active scenario for ${symbol}. Prices restored.`);
            return true;
        }
        return false;
    }

    /**
     * Receives execution reports from the Taker bot.
     * Crucial for Condition-Seeking mode to track partial fills and liquidations.
     */
    static reportExecution(symbol, qty) {
        const state = activeScenarios.get(symbol);
        if (!state || state.phase !== 'RAMPING') return;

        if (state.mode === 'CONDITION_SEEKING') {
            state.accumulatedQty += parseFloat(qty);
            if (state.accumulatedQty >= state.config.targetQty) {
                console.log(`[SCENARIO] 🎯 Condition Met for ${symbol}! Executed ${state.accumulatedQty} >= Target ${state.config.targetQty}. Moving to RECOVERING phase.`);
                state.phase = 'RECOVERING';
                state.phaseStartTime = Date.now();
            }
        }
    }

    /**
     * Used by the Taker bot to strict-cap its execution size during a condition-seeking scenario.
     * Prevents over-shooting the target quantity on a massive single tick.
     */
    static getRemainingQty(symbol) {
        const state = activeScenarios.get(symbol);
        // If not condition seeking, or we've already hit the target (phase > RAMPING), return null (no cap)
        // Wait, if we are recovering, we should probably return 0 to halt Taker until recovered!
        if (!state || state.mode !== 'CONDITION_SEEKING') return null;
        
        if (state.phase === 'RAMPING') {
            return Math.max(0, state.config.targetQty - state.accumulatedQty);
        }
        
        // If we are Holding or Recovering in a qty-capped scenario, we return 0 to completely freeze 
        // the Taker bot at the crashed price, letting the Maker book recover safely.
        return 0;
    }

    /**
     * Tick loop called by the Replicator before fetching the transformer.
     * Updates the state machine based on elapsed time.
     */
    static tick(symbol) {
        const state = activeScenarios.get(symbol);
        if (!state || state.phase === 'IDLE') return;

        const now = Date.now();
        const elapsed = now - state.phaseStartTime;

        if (state.phase === 'RAMPING') {
            const rampMs = state.config.rampMs || 0;
            if (rampMs === 0 || elapsed >= rampMs) {
                state.currentMultiplier = state.targetMultiplier;
                // If deterministic, move to holding. Condition seeking stays in RAMPING until condition met.
                if (state.mode === 'DETERMINISTIC') {
                    state.phase = 'HOLDING';
                    state.phaseStartTime = now;
                }
            } else {
                // Linear easing
                const progress = elapsed / rampMs;
                state.currentMultiplier = 1.0 + (state.config.pct * progress);
            }
        } else if (state.phase === 'HOLDING') {
            const holdMs = state.config.holdMs || 0;
            if (state.config.recovery === 'funding-premium') {
                return; // Never recover, lock the premium
            } else if (state.config.recovery === 'ping-pong') {
                if (holdMs > 0 && elapsed >= holdMs) {
                    state.phase = 'RAMPING';
                    state.pingPongCycle++;
                    state.phaseStartTime = now;
                    // Flip the target multiplier
                    const diff = state.targetMultiplier - 1.0;
                    state.targetMultiplier = 1.0 - diff;
                }
            } else if (holdMs > 0 && Math.abs(elapsed) >= holdMs) { // use absolute just in case
                state.phase = 'RECOVERING';
                state.phaseStartTime = now;
            }
        } else if (state.phase === 'RECOVERING') {
            if (state.config.recovery === 'none') {
                return; // Stuck here forever
            }
            
            const recoverMs = state.config.recoverMs || 0;
            if (recoverMs === 0 || elapsed >= recoverMs) {
                activeScenarios.delete(symbol);
                console.log(`[SCENARIO] ✅ Scenario for ${symbol} completed and fully recovered.`);
            } else {
                // Linear recovery
                const progress = elapsed / recoverMs;
                const distToNormal = 1.0 - state.targetMultiplier;
                state.currentMultiplier = state.targetMultiplier + (distToNormal * progress);
            }
        }
    }

    static getStatus(symbol) {
        const state = activeScenarios.get(symbol);
        if (!state) return { phase: 'IDLE' };
        return {
            phase: state.phase,
            mode: state.mode,
            currentMultiplier: state.currentMultiplier,
            accumulatedQty: state.accumulatedQty
        };
    }
}

module.exports = ScenarioEngine;
