const fetch = require('node-fetch');
const fs = require('fs');
let config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const apiKey = config.testnet.user2_taker.key;
const baseUrl = "https://testnet-futures-hpo.dcxstage.com";

async function testListenKey() {
    const urls = [
        `${baseUrl}/fapi/v1/listenKey`,
        `${baseUrl}/api/v1/listenKey`,
        `${baseUrl}/v1/listenKey`,
        `https://testnet-rails-api.dcxstage.com/api/v1/listenKey`,
        `https://testnet-api.dcxstage.com/api/v1/listenKey`,
    ];
    for (const url of urls) {
        console.log("Testing POST", url);
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'X-MBX-APIKEY': apiKey }
        });
        console.log(res.status, await res.text());
    }
}
testListenKey();
