const fetch = require('node-fetch');

const railsBase = "https://testnet-rails-api.dcxstage.com";
const bearerToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IlYyIn0.eyJjb2luZGN4X2lkIjoiNzUzMDMwM2YtOTJjZS00NTEyLWI4MzMtOTVlMTYyYmI3N2RkIiwidXNlcl9pZCI6Ijc1MzAzMDNmLTkyY2UtNDUxMi1iODMzLTk1ZTE2MmJiNzdkZCIsInBvcnRmb2xpb0ZhY3RvciI6MSwic2Vzc2lvbklkIjoiODRmMTdlNDUtYzE4ZS00MzkxLWEyY2EtZjZmNWJiMjc3MzY1IiwicyI6IndlYiIsInVzZXJBZ2VudCI6IlBvc3RtYW5SdW50aW1lLzcuNTQuMCIsInNpcCI6IjEzMC40MS4yMTguNDciLCJzY2l0eSI6IkNoZW5uYWkiLCJzY291bnRyeSI6IklOIiwic3JlZ2lvbiI6IlROIiwiaWF0IjoxNzgyMDI5MTcwLCJleHAiOjE3ODIxNTg3NzB9.4GS3HgfdFeitfbz0ZWusqE7O6wJoyJEw3PO6Ia_OA9g";

async function run() {
    const bodies = [
        { user: { label: "test", create_api_key_otp: "123456" } },
        { user: { label: "test", otp: "123456" } },
        { user: { label: "test", mfa_code: "123456" } },
        { user: { label: "test" }, otp: "123456" }
    ];
    for (let body of bodies) {
        const res = await fetch(`${railsBase}/api/v2/users/create_api_key`, {
            method: "POST",
            headers: { "Authorization": bearerToken, "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
        console.log("Payload:", JSON.stringify(body), "->", res.status, await res.text());
    }
}
run();
