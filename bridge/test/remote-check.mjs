// Checks a running tunnel from the outside, the way a cloud Hermes reaches it.
//   node test/remote-check.mjs [https://your-domain]   (defaults to the saved ngrok domain)
// Reads the MCP token from ~/.hermes-browser/mcp-token; never prints it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME_DIR = process.env.HERMES_BROWSER_HOME || path.join(os.homedir(), ".hermes-browser");
const base = (process.argv[2] || "https://" + fs.readFileSync(path.join(HOME_DIR, "ngrok-domain"), "utf8").trim()).replace(/\/+$/, "");
const token = process.env.HERMES_BROWSER_MCP_TOKEN || fs.readFileSync(path.join(HOME_DIR, "mcp-token"), "utf8").trim();

const health = await fetch(base + "/health");
console.log(`GET /health -> ${health.status}`);
const anon = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
console.log(`POST /mcp without token -> ${anon.status} (expect 401)`);

const client = new Client({ name: "remote-check", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
const { tools } = await client.listTools();
console.log(`listTools with token -> ${tools.length} tools`);
const r = await client.callTool({ name: "tabs_list", arguments: {} });
const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
console.log(`tabs_list -> ${r.isError ? "ERROR: " + text : text.split("\n")[0] + ` (${text.split("\n").length - 1} tabs)`}`);
await client.close();
process.exit(health.status === 200 && anon.status === 401 && tools.length >= 16 && !r.isError ? 0 : 1);
