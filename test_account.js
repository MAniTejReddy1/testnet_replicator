const crypto = require('crypto');
const fetch = require('node-fetch');
const fs = require('fs');
let config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const apiKey = config.testnet.user1_maker.key;
const apiSecret = config.testnet.user1_maker.secret;
const baseUrl = "https://testnet-futures-hpo.dcxstage.com";

async function test() {
    const timestamp = Date.now();
    const urlObj = new URL(`${baseUrl}/fapi/v2/balance`);
    urlObj.searchParams.set('timestamp', String(timestamp));
    urlObj.searchParams.set('recvWindow', '60000');
    
    const signature = crypto.createHmac('sha256', apiSecret).update('').digest('hex');
    const res = await fetch(urlObj.toString(), {
        method: 'GET',
        headers: {
            'X-AUTH-APIKEY': apiKey,
            'X-AUTH-SIGNATURE': signature,
            'Content-Type': 'application/json'
        }
    });
    console.log(await res.text());
}
test();
