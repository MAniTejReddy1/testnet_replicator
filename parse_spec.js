const fs = require('fs');
const html = fs.readFileSync('spec.html', 'utf8');
const match = html.match(/<script type="application\/json" id="api-reference"[^>]*>([\s\S]*?)<\/script>/);
if (match) {
    const spec = JSON.parse(match[1]);
    const op = spec.paths['/fapi/v1/allOrders'].get;
    console.log(JSON.stringify(op.requestBody, null, 2));
}
