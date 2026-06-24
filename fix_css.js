const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');

// Fix #term-panel inline styles
html = html.replace(
    'style="background:#09090b;border:1px solid rgba(255,255,255,0.08);border-radius:12px;overflow:hidden;display:flex;flex-direction:column;height:400px;box-shadow:0 10px 40px rgba(0,0,0,0.6);transition:height 0.3s;" id="term-panel"',
    'style="background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden;display:flex;flex-direction:column;height:400px;box-shadow:var(--shadow);transition:height 0.3s;" id="term-panel"'
);

// Fix .panel-accent and .ticker-card shadows in inline styles
// They use rgba(..., 0.05) which is fine for both light and dark, but let's make sure they are not hardcoded if they look bad.
// Actually, the user complained about "black shadow shades issues in light theme".
// The main one is probably the term-panel which has 0 10px 40px rgba(0,0,0,0.6).
// Also check if there are other hardcoded black shadows.
html = html.replace(/box-shadow:0 10px 40px rgba\(0,0,0,0\.6\)/g, 'box-shadow:var(--shadow)');

// Also fix the panel-accent gradients which use rgba(24,24,27,0.8) (dark mode color) inline!
// This breaks light mode!
// Line 645: background:linear-gradient(180deg, rgba(24,24,27,0.8), rgba(168,85,247,0.05));
html = html.replace(
    /background:linear-gradient\(180deg, rgba\(24,24,27,0\.8\), rgba\(168,85,247,0\.05\)\);/g,
    'background:linear-gradient(180deg, var(--panel), rgba(168,85,247,0.05));'
);
// Another one: background:rgba(24,24,27,0.8) on term-panel header
html = html.replace(
    /<div style="background:rgba\(24,24,27,0\.8\);border-bottom:1px solid rgba\(255,255,255,0\.08\);display:flex/g,
    '<div style="background:var(--panel);border-bottom:1px solid var(--border);display:flex'
);

// Another one: search input in terminal
html = html.replace(
    /border:1px solid rgba\(255,255,255,0\.1\);/g,
    'border:1px solid var(--border);'
);

// Another one: hover on rows: rgba(30, 41, 59, 0.4)
html = html.replace(/rgba\(30, 41, 59, 0\.4\)/g, 'var(--row-hover)');

fs.writeFileSync('index.html', html);
console.log('Shadows and inline dark colors fixed.');
