const fetch = require('node-fetch');

const apiBase = "https://testnet-api.dcxstage.com";
const railsBase = "https://testnet-rails-api.dcxstage.com";
const futuresUrl = "https://testnet-futures-hpo.dcxstage.com";

const wait = ms => new Promise(r => setTimeout(r, ms));
const randSuffix = () => Math.random().toString(36).substring(2, 10);

async function run() {
    const email = `mani.reddy+test${randSuffix()}@coindcx.com`;
    const password = "Test@123";
    const phone_number = "9" + Math.floor(Math.random() * 1000000000).toString().padStart(9, '0');
    const first_name = "Test", last_name = "Bot";

    const send = async (url, body, token) => {
        const headers = { "Content-Type": "application/json" };
        if (token) headers["Authorization"] = token;
        const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        const text = await res.text();
        let json; try { json = JSON.parse(text); } catch(e){}
        console.log(`[${res.status}] ${url}`, json || text);
        return { status: res.status, json };
    };

    console.log("1. Register");
    let r = await send(`${apiBase}/api/v4/registration`, { user: { email, first_name, last_name, password, pe: false, purpose: "email_verification" } });
    const authToken = r.json.token;

    console.log("2. Email OTP");
    await send(`${apiBase}/api/v4/registration`, { user: { email, token: authToken, first_name, last_name, password, email_otp: "123456", purpose: "email_otp_verification", pe: false } });

    console.log("3. Phone");
    await send(`${apiBase}/api/v4/registration`, { user: { email, token: authToken, phone_number, first_name, last_name, password, country_short_name: "IN", phone_country_short_name: "IN", purpose: "phone_verification", pe: false } });

    console.log("4. Phone OTP");
    await send(`${apiBase}/api/v4/registration`, { user: { email, token: authToken, phone_number, first_name, last_name, password, country_short_name: "IN", phone_country_short_name: "IN", phone_otp: "123456", purpose: "phone_otp_verification", pe: false } });

    console.log("5. Login");
    r = await send(`${apiBase}/api/v3/authenticate`, { email, password, pe: false, piie: false });
    const bearerToken = r.json.auth_token || r.json.token;

    console.log("6. Seed");
    await send(`${futuresUrl}/api/v1/derivatives/futures/wallets/seed_balance`, { currency_short_name: "USDT" }, bearerToken);

    console.log("7. Req OTP");
    await send(`${railsBase}/api/v2/users/request_create_api_key_otp`, { user: { label: "test", purpose: "create_api_key" } }, bearerToken);

    console.log("8. Create API Key");
    r = await send(`${railsBase}/api/v2/users/create_api_key`, {
        user: {
            label: "test",
            otp: "123456",
            email_otp: "123456",
            purpose: "create_api_key"
        }
    }, bearerToken);
}
run().catch(console.error);
