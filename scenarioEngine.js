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
            jitterPct: state.config.jitterPct,
            tickJitterMultiplier: state.tickJitterMultiplier
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
        
        const steps = config.steps || [];
        const isMultiStep = steps.length > 0;
        
        const state = {
            phase: isMultiStep ? 'STEPPING' : 'RAMPING',
            mode: config.targetQty ? 'CONDITION_SEEKING' : 'DETERMINISTIC',
            config,
            startTime: Date.now(),
            phaseStartTime: Date.now(),
            accumulatedQty: 0,
            currentMultiplier: 1.0,
            targetMultiplier: 1.0 + (config.pct || 0),
            pingPongCycle: 0,
            
            // Multi-step configurations:
            steps,
            currentStepIndex: 0,
            stepPhase: 'RAMPING',
            stepStartMultiplier: 1.0,
            
            // Jitter & Safety
            tickJitterMultiplier: 1.0,
            reconciliationRequired: false,
            maxDurationMs: config.maxDurationMs || 300000 // 5 minutes default safety timeout
        };
        
        activeScenarios.set(symbol, state);
        console.log(`[SCENARIO] 🟢 Started ${state.mode} scenario for ${symbol}. isMultiStep: ${isMultiStep}, Target Pct: ${config.pct}`);
        return state;
    }

    static abortScenario(symbol) {
        if (activeScenarios.has(symbol)) {
            const state = activeScenarios.get(symbol);
            state.phase = 'IDLE';
            state.reconciliationRequired = true;
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
        if (!state || (state.phase !== 'RAMPING' && state.phase !== 'STEPPING')) return;

        if (state.mode === 'CONDITION_SEEKING') {
            state.accumulatedQty += parseFloat(qty);
            if (state.accumulatedQty >= state.config.targetQty) {
                console.log(`[SCENARIO] 🎯 Condition Met for ${symbol}! Executed ${state.accumulatedQty} >= Target ${state.config.targetQty}. Moving to RECOVERING phase.`);
                state.phase = 'RECOVERING';
                state.phaseStartTime = Date.now();
                state.reconciliationRequired = true;
            }
        }
    }

    /**
     * Used by the Taker bot to strict-cap its execution size during a condition-seeking scenario.
     * Prevents over-shooting the target quantity on a massive single tick.
     */
    static getRemainingQty(symbol) {
        const state = activeScenarios.get(symbol);
        if (!state || state.mode !== 'CONDITION_SEEKING') return null;
        
        if (state.phase === 'RAMPING' || state.phase === 'STEPPING') {
            return Math.max(0, state.config.targetQty - state.accumulatedQty);
        }
        
        // Return 0 if in HOLDING/RECOVERING to pause Taker execution completely
        return 0;
    }

    /**
     * Tick loop called by the Replicator before fetching the transformer.
     * Updates the state machine based on elapsed time.
     */
    static tick(symbol, currentLtp = null) {
        const state = activeScenarios.get(symbol);
        if (!state || state.phase === 'IDLE') return;

        const now = Date.now();
        
        // 1. Safety Timeout check
        if (now - state.startTime >= state.maxDurationMs) {
            console.log(`[SCENARIO] 🚨 Safety Timeout Exceeded for ${symbol}. Forcing recovery.`);
            state.phase = 'RECOVERING';
            state.phaseStartTime = now;
            state.reconciliationRequired = true;
            state.steps = [];
            state.targetMultiplier = 1.0;
        }

        // 2. Pre-calculated Jitter Noise once per tick to avoid Bid/Ask cross-spread issues
        const jitterPct = state.config.jitterPct || 0;
        if (jitterPct > 0) {
            const noise = (Math.random() * 2 - 1) * jitterPct;
            state.tickJitterMultiplier = 1.0 + noise;
        } else {
            state.tickJitterMultiplier = 1.0;
        }

        const elapsed = now - state.phaseStartTime;

        // 3. Main Multi-Step sequential loop or Single-Scenario state machine
        if (state.phase === 'STEPPING') {
            const currentStep = state.steps[state.currentStepIndex];
            if (!currentStep) {
                state.phase = 'RECOVERING';
                state.phaseStartTime = now;
                state.reconciliationRequired = true;
                return;
            }

            // Dynamic Step Target calculation to prevent index drift
            let stepTargetMultiplier = 1.0;
            if (currentStep.targetPrice && currentLtp) {
                stepTargetMultiplier = parseFloat(currentStep.targetPrice) / parseFloat(currentLtp);
            } else if (currentStep.pct !== undefined) {
                stepTargetMultiplier = 1.0 + parseFloat(currentStep.pct);
            }

            if (state.stepPhase === 'RAMPING') {
                const rampMs = currentStep.rampMs || 0;
                if (rampMs === 0 || elapsed >= rampMs) {
                    state.currentMultiplier = stepTargetMultiplier;
                    state.stepPhase = 'HOLDING';
                    state.phaseStartTime = now;
                } else {
                    const progress = elapsed / rampMs;
                    state.currentMultiplier = state.stepStartMultiplier + ((stepTargetMultiplier - state.stepStartMultiplier) * progress);
                }
            } else if (state.stepPhase === 'HOLDING') {
                state.currentMultiplier = stepTargetMultiplier;
                const holdMs = currentStep.holdMs || 0;
                if (holdMs === 0 || elapsed >= holdMs) {
                    // Transition to next step
                    state.currentStepIndex++;
                    if (state.currentStepIndex < state.steps.length) {
                        state.stepStartMultiplier = state.currentMultiplier;
                        state.stepPhase = 'RAMPING';
                        state.phaseStartTime = now;
                    } else {
                        // Steps finished, transition to recovery
                        state.phase = 'RECOVERING';
                        state.phaseStartTime = now;
                        state.reconciliationRequired = true;
                    }
                }
            }
        } else if (state.phase === 'RAMPING') {
            // Dynamic Target calculation for single targetPrice scenario
            if (state.config.targetPrice && currentLtp) {
                state.targetMultiplier = parseFloat(state.config.targetPrice) / parseFloat(currentLtp);
            }

            const rampMs = state.config.rampMs || 0;
            if (rampMs === 0 || elapsed >= rampMs) {
                state.currentMultiplier = state.targetMultiplier;
                if (state.mode === 'DETERMINISTIC') {
                    state.phase = 'HOLDING';
                    state.phaseStartTime = now;
                }
            } else {
                const progress = elapsed / rampMs;
                state.currentMultiplier = 1.0 + ((state.targetMultiplier - 1.0) * progress);
            }
        } else if (state.phase === 'HOLDING') {
            const holdMs = state.config.holdMs || 0;
            if (state.config.recovery === 'funding-premium') {
                return; // Lock premium forever
            } else if (state.config.recovery === 'ping-pong') {
                if (holdMs > 0 && elapsed >= holdMs) {
                    if (state.pingPongCycle >= (state.config.maxCycles || 10)) {
                        state.phase = 'RECOVERING';
                        state.phaseStartTime = now;
                        state.reconciliationRequired = true;
                    } else {
                        state.phase = 'RAMPING';
                        state.pingPongCycle++;
                        state.phaseStartTime = now;
                        // Flip target multiplier offset
                        const diff = state.targetMultiplier - 1.0;
                        state.targetMultiplier = 1.0 - diff;
                    }
                }
            } else if (holdMs > 0 && elapsed >= holdMs) {
                state.phase = 'RECOVERING';
                state.phaseStartTime = now;
                state.reconciliationRequired = true;
            }
        } else if (state.phase === 'RECOVERING') {
            if (state.config.recovery === 'none') {
                return; // Stuck here forever
            }
            if (state.recoveryStartMultiplier === undefined) {
                state.recoveryStartMultiplier = state.currentMultiplier;
            }
            
            const recoverMs = state.config.recoverMs || 0;
            if (recoverMs === 0 || elapsed >= recoverMs) {
                activeScenarios.delete(symbol);
                console.log(`[SCENARIO] ✅ Scenario for ${symbol} completed and fully recovered.`);
            } else {
                const progress = elapsed / recoverMs;
                // Perfect linear interpolation: start + (1.0 - start) * progress
                state.currentMultiplier = state.recoveryStartMultiplier + ((1.0 - state.recoveryStartMultiplier) * progress);
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
            accumulatedQty: state.accumulatedQty,
            reconciliationRequired: state.reconciliationRequired,
            stepsCount: state.steps.length,
            currentStepIndex: state.currentStepIndex,
            stepPhase: state.stepPhase,
            startTime: state.startTime,
            phaseStartTime: state.phaseStartTime,
            maxDurationMs: state.maxDurationMs,
            // Expose key config fields for UI display
            targetQty: state.config?.targetQty || null,
            pct: state.config?.pct || null,
            config: {
                targetQty: state.config?.targetQty || null,
                pct: state.config?.pct || null,
                rampMs: state.config?.rampMs || null,
                holdMs: state.config?.holdMs || null,
                recoverMs: state.config?.recoverMs || null,
                steps: state.config?.steps || []
            }
        };
    }

    static clearReconciliationFlag(symbol) {
        const state = activeScenarios.get(symbol);
        if (state) {
            state.reconciliationRequired = false;
        }
    }
}

module.exports = ScenarioEngine;
