// Tests the built package (npm run build first) from a folder with no
// node_modules, the way npx runs it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-browser-pkg-"));
fs.cpSync(path.join(here, "..", "dist"), path.join(tmp, "dist"), { recursive: true });
const cli = path.join(tmp, "dist", "cli.mjs");
const home = path.join(tmp, "home");
const env = { ...process.env, HERMES_BROWSER_HOME: home, HERMES_BROWSER_PORT: "18795" };
delete env.HERMES_BROWSER_TOKEN;
const run = (args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });

try {
  assert.equal(run(["version"]).stdout.trim(), JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version);
  console.log("ok: version matches package.json");

  const token = run(["token"]).stdout.trim();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(run(["token"]).stdout.trim(), token);
  console.log("ok: token created once and reused");

  assert.ok(fs.existsSync(path.join(tmp, "dist", "extension", "manifest.json")));
  console.log("ok: extension is bundled");

  const client = new Client({ name: "pkg-smoke", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "serve"], env, stderr: "ignore" }));

  // /pair hands the token only to our extension's Origin.
  const pair = (origin) => new Promise((resolve) => {
    http.request({ method: "POST", host: "127.0.0.1", port: 18795, path: "/pair", headers: origin ? { origin } : {} }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, ...JSON.parse(b || "{}") }));
    }).end();
  });
  let p = await pair("chrome-extension://alioifdhmmimahjfnfccegannpnnlmgm");
  assert.equal(p.status, 200);
  assert.equal(p.token, token);
  assert.equal(p.port, 18795);
  console.log("ok: /pair hands the token to the Hermes Browser extension");
  for (const o of ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "https://evil.example", "null", ""]) {
    p = await pair(o);
    assert.equal(p.status, 403);
    assert.ok(!p.token);
  }
  console.log("ok: /pair refuses other extensions, web pages, and requests without an Origin");

  const { tools } = await client.listTools();
  assert.ok(tools.length >= 17);
  const res = await client.callTool({ name: "tabs_list", arguments: {} });
  assert.match(res.content[0].text, /not connected/);
  await client.close();
  console.log(`ok: bundled bridge serves ${tools.length} tools over stdio without node_modules`);

  console.log("\nALL PACKAGE TESTS PASSED");
} catch (e) {
  console.error("FAILED:", e);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
