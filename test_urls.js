const fetch = require('node-fetch');
const config = require('./config.json');

async function testPaths() {
    const key = config.testnet.user2_taker.key;
    const urls = [
        "https://testnet-futures-hpo.dcxstage.com/api/v1/derivatives/futures/userDataStream",
        "https://testnet-futures-hpo.dcxstage.com/fapi/v1/userDataStream",
        "https://testnet-futures-hpo.dcxstage.com/api/v1/userDataStream",
        "https://testnet-futures-hpo.dcxstage.com/api/v1/derivatives/futures/listenKey",
        "https://testnet-futures-mds-read.dcxstage.com/fapi/v1/listenKey",
        "https://testnet-futures-mds-read.dcxstage.com/api/v1/userDataStream"
    ];

    for (const u of urls) {
        console.log("Testing POST", u);
        const res = await fetch(u, {
            method: 'POST',
            headers: { 'X-AUTH-APIKEY': key, 'X-MBX-APIKEY': key }
        });
        console.log(res.status, await res.text());
    }
}
testPaths();
