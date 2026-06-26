const fs = require('fs');
const fetch = require('node-fetch');

const apiBase = "https://testnet-api.dcxstage.com";
const railsBase = "https://testnet-rails-api.dcxstage.com";
const futuresUrl = "https://testnet-futures-hpo.dcxstage.com";

const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const randSuffix = (len = 8) => Math.random().toString(36).substring(2, 2+len);
const randPhone = () => [6,7,8,9][Math.floor(Math.random()*4)] + Array.from({length:9}).map(()=>Math.floor(Math.random()*10)).join('');

async function rawSend(label, req) {
  return new Promise((resolve, reject) => {
    fetch(req.url, {
      method: req.method,
      headers: {
        "User-Agent": "PostmanRuntime/7.32.3",
        ...req.header
      },
      body: req.body ? req.body.raw : undefined
    }).then(async res => {
      const bodyText = await res.text();
      let bodyJson = null;
      try { bodyJson = JSON.parse(bodyText); } catch(e){}
      if (res.status >= 400) return reject(new Error(`${label} failed [${res.status}]: ${bodyText}`));
      await wait(200);
      resolve({ res, bodyJson, bodyText });
    }).catch(reject);
  });
}

async function send(label, req) {
  const retries = 5;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try { return await rawSend(label, req); }
    catch (err) {
      if (attempt === retries) throw err;
      await wait(2000);
    }
  }
}

async function createUserAndKey(labelPrefix) {
  const suffix = randSuffix();
  const email = `mani.reddy+${suffix}@coindcx.com`;
  const password = "Test@123";
  const phone_number = randPhone();
  const first_name = "Replicator", last_name = "User";

  let step = await send(`${labelPrefix}_1_Register`, {
    url: `${apiBase}/api/v4/registration`, method: "POST", header: { "Content-Type": "application/json" },
    body: { raw: JSON.stringify({ user: { email, first_name, last_name, referral: "", password, pe: false, purpose: "email_verification" } }) }
  });
  const authToken = (step.bodyJson && step.bodyJson.token) ? step.bodyJson.token : "";

  await send(`${labelPrefix}_2_EmailOtpVerify`, {
    url: `${apiBase}/api/v4/registration`, method: "POST", header: { "Content-Type": "application/json" },
    body: { raw: JSON.stringify({ user: { email, token: authToken, first_name, last_name, referral: "", password, email_otp: "123456", purpose: "email_otp_verification", pe: false } }) }
  });

  await send(`${labelPrefix}_3_AddPhone`, {
    url: `${apiBase}/api/v4/registration`, method: "POST", header: { "Content-Type": "application/json" },
    body: { raw: JSON.stringify({ user: { email, token: authToken, phone_number, first_name, last_name, referral: "", password, country_short_name: "IN", phone_country_short_name: "IN", purpose: "phone_verification", pe: false } }) }
  });

  await send(`${labelPrefix}_4_PhoneOtpVerify`, {
    url: `${apiBase}/api/v4/registration`, method: "POST", header: { "Content-Type": "application/json" },
    body: { raw: JSON.stringify({ user: { email, token: authToken, phone_number, first_name, last_name, referral: "", password, country_short_name: "IN", phone_country_short_name: "IN", phone_otp: "123456", purpose: "phone_otp_verification", pe: false } }) }
  });

  step = await send(`${labelPrefix}_5_Login`, {
    url: `${apiBase}/api/v3/authenticate`, method: "POST", header: { "Content-Type": "application/json" },
    body: { raw: JSON.stringify({ email, password, pe: false, piie: false }) }
  });
  const bearerToken = (step.bodyJson && (step.bodyJson.auth_token || step.bodyJson.token)) ? (step.bodyJson.auth_token || step.bodyJson.token) : "";

  try {
    await send(`${labelPrefix}_6_SeedBalance`, {
      url: `${futuresUrl}/api/v1/derivatives/futures/wallets/seed_balance`, method: "POST",
      header: { "Authorization": bearerToken, "Content-Type": "application/json" },
      body: { raw: JSON.stringify({ currency_short_name: "USDT" }) }
    });
  } catch (e) { }

  await send(`${labelPrefix}_7_RequestApiKeyOtp`, {
    url: `${railsBase}/api/v2/users/request_create_api_key_otp`, method: "POST",
    header: { "Authorization": bearerToken, "Content-Type": "application/json" },
    body: { raw: JSON.stringify({ user: { label: labelPrefix, purpose: "create_api_key" } }) }
  });

  const finalRes = await send(`${labelPrefix}_8_CreateApiKey`, {
    url: `${railsBase}/api/v2/users/create_api_key`, method: "POST",
    header: { "Authorization": bearerToken, "Content-Type": "application/json" },
    body: { raw: JSON.stringify({
      user: { label: labelPrefix, otp: "123456", email_otp: "123456", purpose: "create_api_key" }
    }) }
  });
  const resData = finalRes.bodyJson;
  const key = resData && (resData.key || resData.api_key || (resData.data && (resData.data.key || resData.data.api_key)));
  const secret = resData && (resData.secret || resData.api_secret || (resData.data && (resData.data.secret || resData.data.api_secret)));
  
  if (key && secret) return { key, secret, email };
  throw new Error("Failed to create API key for " + labelPrefix);
}

(async () => {
  try {
    const label = process.argv[2] || "AUTO_USER";
    const res = await createUserAndKey(label);
    console.log(JSON.stringify(res));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();
