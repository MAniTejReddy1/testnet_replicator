const fetch = require("node-fetch");
const apiBase = "https://testnet-api.dcxstage.com";
const suffix = Math.random().toString(36).substring(2, 10);
const email = `mani.reddy+${suffix}@coindcx.com`;
const password = "Test@123";
const phone_number = "9" + Array.from({length:9}).map(()=>Math.floor(Math.random()*10)).join("");

(async () => {
  console.log("Email:", email, "Phone:", phone_number);
  
  let r1 = await fetch(`${apiBase}/api/v4/registration`, { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ user: { email, first_name:"Jenkins", last_name:"Runner", referral: "", password, pe: false, purpose: "email_verification" } }) });
  let d1 = await r1.json();
  const token = d1.token;
  
  await fetch(`${apiBase}/api/v4/registration`, { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ user: { email, token, first_name:"Jenkins", last_name:"Runner", referral: "", password, email_otp: "123456", purpose: "email_otp_verification", pe: false } }) });
  
  await fetch(`${apiBase}/api/v4/registration`, { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ user: { email, token, phone_number, first_name:"Jenkins", last_name:"Runner", referral: "", password, country_short_name: "IN", phone_country_short_name: "IN", purpose: "phone_verification", pe: false } }) });
  
  let r4 = await fetch(`${apiBase}/api/v4/registration`, { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ user: { email, token, phone_number, first_name:"Jenkins", last_name:"Runner", referral: "", password, country_short_name: "IN", phone_country_short_name: "IN", phone_otp: 123456, purpose: "phone_otp_verification", pe: false } }) });
  console.log("4. Phone OTP Verify (123456 number):", r4.status, await r4.text());
})();
