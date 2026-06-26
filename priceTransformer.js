// priceTransformer.js

/**
 * Pure functions to apply the 5 independent scenario axes to orderbook prices.
 */

function applyPriceAxes(rawPrice, side, axes, levelIndex = 0) {
    let price = parseFloat(rawPrice);

    if (!axes) return price;

    // 1. Flash Crash Multiplier (shifts the entire market)
    if (axes.multiplier) {
        price *= axes.multiplier;
    }

    // 2. Volatility Jitter (adds synthetic random noise to prevent flatlines)
    if (axes.jitterPct) {
        const noise = (Math.random() * 2 - 1) * axes.jitterPct;
        price *= (1 + noise);
    }

    // 3. Spread Bias (widens or tightens the spread artificially)
    if (axes.spreadBias) {
        if (side === 'BUY') {
            price *= (1 - axes.spreadBias);
        } else if (side === 'SELL') {
            price *= (1 + axes.spreadBias);
        }
    }
    
    // 4. Exact Target Spread (overrides spreadBias if both are provided)
    if (axes.targetSpreadPct) {
        if (side === 'BUY') {
            price *= (1 - (axes.targetSpreadPct / 2));
        } else if (side === 'SELL') {
            price *= (1 + (axes.targetSpreadPct / 2));
        }
    }

    return price;
}

function applyDepthSkew(levels, side, axes) {
    if (!axes || !axes.depthSkew) return levels;

    const skew = axes.depthSkew;
    
    // Simulate completely draining liquidity from one side
    if (skew === 'drain-bids' && side === 'BUY') return levels.slice(0, 1);
    if (skew === 'drain-asks' && side === 'SELL') return levels.slice(0, 1);

    // Simulate generally thin markets across the board
    if (skew === 'thin') return levels.slice(0, 2);

    return levels;
}

function applyProfileSkew(rawQty, side, axes, levelIndex) {
    let qty = parseFloat(rawQty);
    if (!axes || !axes.profileSkew) return qty;
    
    const skew = axes.profileSkew;
    
    if (skew === 'flat') {
        return 1.0; // Exact 1.0 at every level
    }
    if (skew === 'stepped') {
        return Math.pow(2, levelIndex); // 1, 2, 4, 8, 16...
    }
    if (skew === 'dust') {
        return 0.001; // Tiny dust amounts
    }
    if (skew === 'wall-bids') {
        return side === 'BUY' ? qty * 10 : qty * 0.1;
    }
    if (skew === 'wall-asks') {
        return side === 'SELL' ? qty * 10 : qty * 0.1;
    }

    return qty;
}

module.exports = {
    applyPriceAxes,
    applyDepthSkew,
    applyProfileSkew
};
