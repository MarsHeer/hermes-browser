// Two bridges on one port: the second (HTTP, like the cloud tunnel) shares the
// first's extension connection, and takes over when the first stops.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WS_PORT = 18785, HTTP_PORT = 18786, EXT_TOKEN = "peer-test-token", MCP_TOKEN = "peer-mcp-token-0123456789";
const env = {
  ...process.env, HERMES_BROWSER_PORT: String(WS_PORT), HERMES_BROWSER_HTTP_PORT: String(HTTP_PORT),
  HERMES_BROWSER_TOKEN: EXT_TOKEN, HERMES_BROWSER_MCP_TOKEN: MCP_TOKEN,
  HERMES_BROWSER_HOME: path.join(os.tmpdir(), "hermes-browser-peer-smoke"),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitLog = (proc, re, ms = 8000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timed out waiting for ${re}`)), ms);
  proc.stderr.on("data", (d) => { if (re.test(d)) { clearTimeout(t); resolve(); } });
});

// Bridge A: stdio mode, like one a local Hermes started.
const a = spawn(process.execPath, [path.join(here, "..", "server.mjs")], { env, stdio: ["pipe", "ignore", "pipe"] });
await waitLog(a, /waiting for the extension/);

// Fake extension that reconnects like the real one.
let ext = null, stopExt = false, lastClient = null;
function connectExt() {
  if (stopExt) return;
  const s = new WebSocket(`ws://127.0.0.1:${WS_PORT}/?token=${EXT_TOKEN}`, { origin: "chrome-extension://abc" });
  s.on("open", () => { ext = s; });
  s.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "call") { lastClient = m.client; s.send(JSON.stringify({ type: "result", id: m.id, result: { content: [{ type: "text", text: `echo ${m.tool}` }] } })); }
  });
  s.on("error", () => {});
  s.on("close", () => { if (ext === s) ext = null; setTimeout(connectExt, 300); });
}
connectExt();
while (!ext) await sleep(50);

let b;
try {
  // A web page can't pose as a peer (browsers always send an Origin).
  const evil = new WebSocket(`ws://127.0.0.1:${WS_PORT}/?role=peer&token=${EXT_TOKEN}`, { origin: "https://evil.example" });
  const code = await new Promise((r) => { evil.on("unexpected-response", (_q, res) => r(res.statusCode)); evil.on("open", () => r(101)); evil.on("error", () => {}); });
  assert.equal(code, 403);
  const wrong = new WebSocket(`ws://127.0.0.1:${WS_PORT}/?role=peer&token=nope`);
  assert.equal(await new Promise((r) => { wrong.on("unexpected-response", (_q, res) => r(res.statusCode)); wrong.on("open", () => r(101)); wrong.on("error", () => {}); }), 401);
  console.log("ok: peers need the token and no browser Origin");

  // Bridge B: HTTP mode on the same port, like the cloud tunnel.
  b = spawn(process.execPath, [path.join(here, "..", "server.mjs"), "--http"], { env, stdio: ["ignore", "ignore", "pipe"] });
  await Promise.all([waitLog(b, /sharing its browser connection/), waitLog(b, /MCP over HTTP/)]);
  console.log("ok: second bridge joined the first instead of failing");

  const client = new Client({ name: "peer-smoke", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${HTTP_PORT}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${MCP_TOKEN}` } },
  }));
  let r = await client.callTool({ name: "tabs_list", arguments: {} });
  assert.equal(r.content[0].text, "echo tabs_list");
  console.log("ok: call through the second bridge reached the extension via the first");
  assert.match(lastClient || "", /^http-\d+-[0-9a-f]+$/);
  const httpClient = lastClient;

  // Bridge A's own (stdio) agent must arrive as a different client.
  const local = new Client({ name: "peer-smoke-local", version: "0" });
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  await local.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, "..", "server.mjs")], env, stderr: "ignore" }));
  // A new bridge joins as a peer a moment after it starts.
  let lr;
  for (let i = 0; i < 30; i++) {
    lr = await local.callTool({ name: "tabs_list", arguments: {} });
    if (!lr.isError) break;
    await sleep(100);
  }
  assert.ok(!lr.isError, lr.content?.[0]?.text);
  assert.match(lastClient || "", /^stdio-\d+-[0-9a-f]+$/, `client=${lastClient}`);
  assert.notEqual(lastClient, httpClient);
  await local.close();
  console.log("ok: each agent is tagged with its own client id (separate current tabs)");

  // Status query (what `hermes-browser doctor` uses).
  const st = await new Promise((resolve) => {
    const s = new WebSocket(`ws://127.0.0.1:${WS_PORT}/?role=peer&token=${EXT_TOKEN}`);
    s.on("open", () => s.send(JSON.stringify({ type: "status", id: 1 })));
    s.on("message", (raw) => { resolve(JSON.parse(raw)); s.close(); });
  });
  assert.equal(st.extension, true);
  console.log("ok: status query reports the extension connected");

  // Stop A: B takes the port, the extension reconnects to B, calls keep working.
  a.kill();
  await waitLog(b, /waiting for the extension/);
  for (let i = 0; i < 40; i++) {
    r = await client.callTool({ name: "find", arguments: { query: "x" } });
    if (!r.isError) break;
    await sleep(200);
  }
  assert.equal(r.content[0].text, "echo find");
  console.log("ok: second bridge took over after the first stopped");

  await client.close();
  console.log("\nALL PEER TESTS PASSED");
} catch (e) {
  console.error("FAILED:", e);
  process.exitCode = 1;
} finally {
  stopExt = true;
  try { ext?.close(); } catch {}
  a.kill();
  b?.kill();
  setTimeout(() => process.exit(), 200);
}
