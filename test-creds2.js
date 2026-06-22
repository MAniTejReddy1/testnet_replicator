const fetch = require('node-fetch');

const railsBase = "https://testnet-rails-api.dcxstage.com";
// using previous token
const bearerToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IlYyIn0.eyJjb2luZGN4X2lkIjoiNzUzMDMwM2YtOTJjZS00NTEyLWI4MzMtOTVlMTYyYmI3N2RkIiwidXNlcl9pZCI6Ijc1MzAzMDNmLTkyY2UtNDUxMi1iODMzLTk1ZTE2MmJiNzdkZCIsInBvcnRmb2xpb0ZhY3RvciI6MSwic2Vzc2lvbklkIjoiODRmMTdlNDUtYzE4ZS00MzkxLWEyY2EtZjZmNWJiMjc3MzY1IiwicyI6IndlYiIsInVzZXJBZ2VudCI6IlBvc3RtYW5SdW50aW1lLzcuNTQuMCIsInNpcCI6IjEzMC40MS4yMTguNDciLCJzY2l0eSI6IkNoZW5uYWkiLCJzY291bnRyeSI6IklOIiwic3JlZ2lvbiI6IlROIiwiaWF0IjoxNzgyMDI5MTcwLCJleHAiOjE3ODIxNTg3NzB9.4GS3HgfdFeitfbz0ZWusqE7O6wJoyJEw3PO6Ia_OA9g";

async function run() {
    const res = await fetch(`${railsBase}/api/v2/users/create_api_key?otp=123456&label=test`, {
        headers: { "Authorization": bearerToken }
    });
    console.log(await res.text());
}
run();
