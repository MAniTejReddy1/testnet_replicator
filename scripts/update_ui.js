const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'replicator.js');
let content = fs.readFileSync(file, 'utf8');

// The getHtmlUI function starts at around line 1554 and ends with } after </html>
const startRegex = /function getHtmlUI\(\) \{[\s\S]*?return `<!DOCTYPE html>[\s\S]*?<\/html>`;\n\}/;

const newFunc = `function getHtmlUI() {
    return require('fs').readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
}`;

if (startRegex.test(content)) {
    content = content.replace(startRegex, newFunc);
    fs.writeFileSync(file, content, 'utf8');
    console.log("Successfully replaced getHtmlUI in replicator.js");
} else {
    console.error("Could not find getHtmlUI function with the expected format");
    process.exit(1);
}
