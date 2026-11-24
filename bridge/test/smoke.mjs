// Smoke test: launches the bridge like Hermes would (MCP over stdio), plays the
// part of the Chrome extension over WebSocket, and checks the auth gates.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18765, TOKEN = "smoke-test-token";
const env = {
  ...process.env, HERMES_BROWSER_PORT: String(PORT), HERMES_BROWSER_TOKEN: TOKEN,
  HERMES_BROWSER_HOME: path.join(os.tmpdir(), "hermes-browser-smoke"),
};

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, "..", "server.mjs")], env, stderr: "ignore" }));

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(", "));
assert.ok(tools.length >= 16);

// Not connected yet -> helpful error, not a hang.
let r = await client.callTool({ name: "tabs_list", arguments: {} });
assert.equal(r.isError, true);
assert.match(r.content[0].text, /not connected/);
console.log("ok: reports extension not connected");

const tryConnect = (origin, token) => new Promise((res) => {
  const s = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${token}`, { origin });
  s.on("open", () => res(s));
  s.on("error", () => res(null));
  s.on("unexpected-response", () => res(null));
});

assert.equal(await tryConnect("https://evil.example", TOKEN), null);
console.log("ok: web-page origin rejected");
assert.equal(await tryConnect("chrome-extension://abc", "wrong"), null);
console.log("ok: bad token rejected");

const ext = await tryConnect("chrome-extension://abc", TOKEN);
assert.ok(ext);
ext.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.type !== "call") return;
  const result = m.tool === "screenshot"
    ? { content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }, { type: "text", text: "shot" }] }
    : m.tool === "click" ? null
    : { content: [{ type: "text", text: `echo ${m.tool} ${JSON.stringify(m.args)}` }] };
  ext.send(JSON.stringify(result ? { type: "result", id: m.id, result } : { type: "result", id: m.id, error: "ref_9 not found" }));
});
await new Promise((r) => setTimeout(r, 100));
console.log("ok: extension connected");

r = await client.callTool({ name: "navigate", arguments: { url: "example.com", tabId: 3 } });
assert.equal(r.content[0].text, 'echo navigate {"url":"example.com","tabId":3}');
console.log("ok: call forwarded with args");

r = await client.callTool({ name: "screenshot", arguments: {} });
assert.equal(r.content[0].type, "image");
assert.match(r.content.at(-1).text, /Screenshot saved to: /);
console.log("ok: image passed through and saved:", r.content.at(-1).text.split(": ")[1]);

r = await client.callTool({ name: "click", arguments: { ref: "ref_9" } });
assert.equal(r.isError, true);
assert.match(r.content[0].text, /ref_9 not found/);
console.log("ok: extension errors surface as tool errors");

ext.close();
await client.close();
console.log("\nALL SMOKE TESTS PASSED");
process.exit(0);
