// HTTP-mode smoke test: starts the bridge with --http, plays the extension over
// WebSocket, and calls tools through the real MCP Streamable HTTP client.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WS_PORT = 18775, HTTP_PORT = 18776, EXT_TOKEN = "ext-test-token", MCP_TOKEN = "mcp-test-token-0123456789";
const proc = spawn(process.execPath, [path.join(here, "..", "server.mjs"), "--http"], {
  env: {
    ...process.env, HERMES_BROWSER_PORT: String(WS_PORT), HERMES_BROWSER_HTTP_PORT: String(HTTP_PORT),
    HERMES_BROWSER_TOKEN: EXT_TOKEN, HERMES_BROWSER_MCP_TOKEN: MCP_TOKEN,
    HERMES_BROWSER_HOME: path.join(os.tmpdir(), "hermes-browser-http-smoke"),
  },
  stdio: ["ignore", "ignore", "pipe"],
});
await new Promise((resolve, reject) => {
  proc.stderr.on("data", (d) => /MCP over HTTP/.test(d) && resolve());
  proc.on("exit", (c) => reject(new Error("bridge exited " + c)));
  setTimeout(() => reject(new Error("bridge did not start")), 5000);
});
const base = `http://127.0.0.1:${HTTP_PORT}`;
const cleanup = () => proc.kill();

try {
  // Auth gates on the HTTP side.
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "0" } } };
  const post = (headers) => fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(init) });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ authorization: "Bearer wrong" })).status, 401);
  console.log("ok: /mcp rejects missing and wrong bearer tokens");
  assert.equal((await fetch(base + "/health")).status, 200);
  assert.equal((await fetch(base + "/other")).status, 404);
  console.log("ok: /health open, other paths 404");

  // Fake extension.
  const ext = new WebSocket(`ws://127.0.0.1:${WS_PORT}/?token=${EXT_TOKEN}`, { origin: "chrome-extension://abc" });
  await new Promise((r, j) => { ext.on("open", r); ext.on("error", j); });
  ext.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type !== "call") return;
    const result = m.tool === "screenshot"
      ? { content: [{ type: "image", mimeType: "image/jpeg", data: "/9j/4AAQ" }, { type: "text", text: "shot" }] }
      : { content: [{ type: "text", text: `echo ${m.tool} ${JSON.stringify(m.args)}` }] };
    ext.send(JSON.stringify({ type: "result", id: m.id, result }));
  });

  // Real MCP client over Streamable HTTP with the bearer token.
  const client = new Client({ name: "http-smoke", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${MCP_TOKEN}` } },
  }));
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 17 && tools.some((t) => t.name === "handle_dialog"));
  console.log(`ok: listTools over HTTP -> ${tools.length} tools`);

  let r = await client.callTool({ name: "navigate", arguments: { url: "example.com" } });
  assert.equal(r.content[0].text, 'echo navigate {"url":"example.com"}');
  console.log("ok: tool call forwarded to extension over HTTP");

  r = await client.callTool({ name: "screenshot", arguments: {} });
  assert.equal(r.content[0].type, "image");
  console.log("ok: image content returned over HTTP");

  // Several calls in parallel share the one extension connection.
  const many = await Promise.all([1, 2, 3, 4, 5].map((i) => client.callTool({ name: "find", arguments: { query: "q" + i } })));
  many.forEach((m, i) => assert.ok(m.content[0].text.includes(`"q${i + 1}"`)));
  console.log("ok: 5 concurrent calls routed correctly");

  await client.close();
  ext.close();
  console.log("\nALL HTTP SMOKE TESTS PASSED");
} catch (e) {
  console.error("FAILED:", e);
  process.exitCode = 1;
} finally {
  cleanup();
}
