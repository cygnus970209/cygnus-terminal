// Run by the ignored Rust interoperability test. Credentials remain in memory;
// only a test fixture can approve the request. Never touches real client configs.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import assert from "node:assert/strict";
const root = process.env.CYGNUS_QA_MCP_SDK;
if (!root) throw new Error("Set CYGNUS_QA_MCP_SDK to an installed official TypeScript MCP SDK directory");
const { auth } = await import(pathToFileURL(join(root, "dist/esm/client/auth.js")));
const { Client } = await import(pathToFileURL(join(root, "dist/esm/client/index.js")));
const { StreamableHTTPClientTransport } = await import(pathToFileURL(join(root, "dist/esm/client/streamableHttp.js")));
const serverUrl = new URL(process.argv[2]);
let information, tokens, verifier, authorizationUrl;
const provider = {
  redirectUrl: "http://127.0.0.1:54321/callback",
  clientMetadata: { client_name: "Official SDK fixture", redirect_uris: ["http://127.0.0.1:54321/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] },
  state: () => "sdk-fixture-state",
  clientInformation: () => information,
  saveClientInformation: (value) => { information = value; },
  tokens: () => tokens,
  saveTokens: (value) => { tokens = value; },
  redirectToAuthorization: (value) => { authorizationUrl = value; },
  saveCodeVerifier: (value) => { verifier = value; },
  codeVerifier: () => verifier,
};
assert.equal(await auth(provider, { serverUrl }), "REDIRECT");
let response = await fetch(authorizationUrl, { redirect: "manual" });
assert.equal(response.status, 200);
const html = await response.text();
const waitPath = html.match(/url=(\/oauth\/wait\/[A-Za-z0-9_-]+)/)[1];
for (let attempt = 0; attempt < 200; attempt++) {
  response = await fetch(new URL(waitPath, serverUrl), { redirect: "manual" });
  if (response.status === 303) break;
  assert.equal(response.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 25));
}
assert.equal(response.status, 303);
const callback = new URL(response.headers.get("location"));
assert.equal(callback.searchParams.get("state"), "sdk-fixture-state");
assert.equal(callback.searchParams.get("iss"), serverUrl.origin);
assert.equal(await auth(provider, { serverUrl, authorizationCode: callback.searchParams.get("code") }), "AUTHORIZED");
const firstRefresh = tokens.refresh_token;
assert.equal(await auth(provider, { serverUrl }), "AUTHORIZED");
assert.notEqual(tokens.refresh_token, firstRefresh);
const transport = new StreamableHTTPClientTransport(serverUrl, { authProvider: provider });
const client = new Client({ name: "oauth-sdk-fixture", version: "1.0" });
await client.connect(transport);
const tools = await client.listTools();
assert.ok(tools.tools.some((tool) => tool.name === "cygnus_list_servers"));
assert.ok(!tools.tools.some((tool) => tool.name === "cygnus_execute"));
await client.close();
console.log("PASS: official SDK discovery, registration, browser authorization, PKCE exchange, automatic refresh and MCP connection");
