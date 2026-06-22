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
        // For simplicity, we apply a percentage penalty depending on the side.
        // A spreadBias of 0.005 means Best Bid drops 0.5% and Best Ask rises 0.5%.
        if (side === 'BUY') {
            price *= (1 - axes.spreadBias);
        } else if (side === 'SELL') {
            price *= (1 + axes.spreadBias);
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

module.exports = {
    applyPriceAxes,
    applyDepthSkew
};
