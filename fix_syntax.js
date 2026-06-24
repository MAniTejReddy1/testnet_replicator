const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'index.html');
let content = fs.readFileSync(file, 'utf8');

// Replace all occurrences of \\' with \'
const newContent = content.replace(/\\\\'/g, "\\'");

fs.writeFileSync(file, newContent, 'utf8');
console.log("Fixed double backslashes in index.html");
