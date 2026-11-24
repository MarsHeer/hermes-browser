// Live end-to-end test: acts as Hermes (MCP client), launches the real bridge,
// waits for the real Chrome extension to connect, then drives a local test page.
// Runs twice: normal (debugger path) and with HERMES_BROWSER_FORCE_FALLBACK=1.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WAIT_S = Number(process.env.LIVE_WAIT_S || 600);
const MODES = (process.env.LIVE_MODES || "normal,fallback").split(",");

// Serve the fixture (without the page.js tag; the extension injects its own).
const html = fs.readFileSync(path.join(here, "fixture.html"), "utf8").replace(/<script src=[^>]+><\/script>/, "");
const site = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  if (req.url.startsWith("/long")) {
    return res.end(`<title>Long</title>${Array.from({ length: 200 }, (_, i) => `<p>Row ${i}</p>`).join("")}<button onclick="this.textContent='clicked far'">Far button</button>`);
  }
  if (req.url.startsWith("/dialog")) {
    return res.end(`<title>Dialogs</title><p id=out></p>
      <button onclick="out.textContent='confirm:'+confirm('Delete everything?')">Confirm delete</button>
      <button onclick="out.textContent='prompt:'+prompt('Your name?','anon')">Ask name</button>
      <button onclick="alert('Saved!'); out.textContent='alerted'">Show alert</button>`);
  }
  if (req.url.startsWith("/frames")) {
    // The iframe is served from "localhost" while the page is on 127.0.0.1: cross-origin.
    const port = site.address().port;
    return res.end(`<title>Frames</title><h1>Article</h1><div style="height:260px"></div>
      <iframe src="http://localhost:${port}/consent" style="width:420px;height:180px;margin-left:90px;border:3px solid #888"></iframe>`);
  }
  if (req.url.startsWith("/consent")) {
    return res.end(`<p>We use cookies</p><input id=nick placeholder="Nickname">
      <button onclick="s.textContent='accepted:'+nick.value+':'+event.isTrusted">Accept all</button><p id=s></p>`);
  }
  res.end(html);
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${site.address().port}`;

let total = { pass: 0, fail: 0 };

async function runMode(mode) {
  console.log(`\n=== mode: ${mode} ===`);
  const env = { ...process.env, HERMES_BROWSER_FORCE_FALLBACK: mode === "fallback" ? "1" : "0" };
  const client = new Client({ name: "live-test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, "..", "server.mjs")], env, stderr: "inherit" }));

  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const txt = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return { ...r, txt, img: r.content.find((c) => c.type === "image") };
  };
  const ok = async (name, args) => {
    const r = await call(name, args);
    if (r.isError) throw new Error(`${name} failed: ${r.txt}`);
    return r;
  };
  const refOf = (txt, needle) => {
    const line = txt.split("\n").find((l) => l.toLowerCase().includes(needle.toLowerCase()));
    const m = line && line.match(/\[((?:f\d+:)?ref_\d+)\]/);
    if (!m) throw new Error(`no ref for "${needle}" in:\n${txt}`);
    return m[1];
  };
  const js = async (code) => (await ok("javascript", { code })).txt;
  const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
  let fallbacks = 0;
  const countFb = (r) => { if (r.txt.includes("[fallback:")) fallbacks++; return r; };

  const activeIds = (txt) => txt.split("\n").filter((l) => /^\d+/.test(l) && l.includes("[active]")).map((l) => Number(l.split(" ")[0])).sort().join(",");
  let background = false, userActive = null;
  let focusLostAt = null; // first step after which the user's tab was no longer in front
  async function step(name, fn) {
    try { const note = await fn(); total.pass++; console.log(`PASS ${name}${note ? "  -> " + note : ""}`); }
    catch (e) { total.fail++; console.log(`FAIL ${name}\n     ${String(e.message).split("\n").join("\n     ")}`); }
    if (typeof userActive === "string" && background && !focusLostAt) {
      const lt = (await call("tabs_list")).txt;
      const now = activeIds(lt);
      if (now !== userActive) {
        focusLostAt = name;
        const who = lt.split("\n").filter((l) => /^\d+/.test(l) && l.includes("[active]") && !userActive.split(",").includes(l.split(" ")[0]))
          .map((l) => l.replace(/\|.*\|/, "|").slice(0, 160)).join("; ");
        console.log(`     (the user's tab lost the front after this step: ${userActive} -> ${now}; now in front: ${who})`);
      }
    }
  }

  // Wait until the extension that connects is the version on disk (i.e. it was reloaded).
  const want = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "extension", "manifest.json"), "utf8")).version;
  console.log(`Waiting up to ${WAIT_S}s for extension v${want} to connect (reload it in chrome://extensions)...`);
  const t0 = Date.now();
  for (let warned = false; ; ) {
    const r = await call("tabs_list");
    if (!r.isError && r.txt.includes(`extension v${want}`)) break;
    if (!r.isError && !warned) { console.log("Connected extension is an older version; waiting for reload..."); warned = true; }
    if (Date.now() - t0 > WAIT_S * 1000) { console.log("TIMEOUT: extension v" + want + " never connected"); process.exit(2); }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Normal mode runs in a background tab while the user's tab stays in front.
  // Fallback mode (debugger blocked) can't screenshot a background tab, so it
  // works in front, as it would have to for a real user.
  background = mode === "normal";
  userActive = activeIds((await ok("tabs_list")).txt);

  let tabId, outline;
  await step(`tabs_create opens test page in Hermes group${background ? " (in the background)" : ""}`, async () => {
    const r = await ok("tabs_create", { url: base + "/", ...(background ? {} : { focus: true }) });
    tabId = Number(r.txt.match(/Tab (\d+)/)[1]);
    const l = await ok("tabs_list");
    expect(l.txt.includes(`${tabId} (current)`) && l.txt.includes("[Hermes]"), l.txt);
    if (background) expect(activeIds(l.txt) === userActive, `the user's tab lost focus: active ${activeIds(l.txt)} vs ${userActive}`);
  });

  await step("read_page interactive outline", async () => {
    outline = (await ok("read_page", { filter: "interactive" })).txt;
    for (const n of ['textbox "Email"', 'combobox "Plan"', 'checkbox "I agree"', 'button "Create account"']) expect(outline.includes(n), `missing ${n}\n${outline}`);
  });

  await step("click + type into email", async () => {
    countFb(await ok("click", { ref: refOf(outline, 'textbox "Email"') }));
    countFb(await ok("type", { text: "first@x.io" }));
    const v = await js("document.activeElement.id + '=' + document.querySelector('#email').value");
    expect(v.includes("email=first@x.io"), v);
  });

  await step("key: ctrl+a Backspace, retype", async () => {
    countFb(await ok("key", { keys: "ctrl+a Backspace" }));
    countFb(await ok("type", { text: "hermes@x.io" }));
    const v = await js("document.querySelector('#email').value");
    expect(v.includes("hermes@x.io") && !v.includes("first"), v);
  });

  await step("form_input select + checkbox", async () => {
    await ok("form_input", { ref: refOf(outline, 'combobox "Plan"'), value: "Pro plan" });
    const r = await ok("form_input", { ref: refOf(outline, 'checkbox "I agree"'), value: true });
    expect(r.txt.includes("checked=true"), r.txt);
  });

  await step("click submit via find ref, read result text", async () => {
    const f = await ok("find", { query: "Create account" });
    expect(f.txt.startsWith("- button"), f.txt);
    countFb(await ok("click", { ref: refOf(f.txt, "Create account") }));
    const t = await ok("get_page_text");
    expect(t.txt.includes("submitted hermes@x.io pro true"), t.txt);
  });

  await step("Enter key submits form", async () => {
    await js("document.getElementById('out').textContent=''; document.querySelector('#email').focus()");
    countFb(await ok("key", { keys: "End" }));
    countFb(await ok("type", { text: "x" }));
    countFb(await ok("key", { keys: "Enter" }));
    const t = await js("document.getElementById('out').textContent");
    expect(t.includes("submitted hermes@x.iox"), t);
  });

  await step("type fires real key events per character", async () => {
    await js(`window.__keys = []; const e = document.querySelector('#email'); e.value = ''; e.focus();
      for (const t of ['keydown', 'keypress', 'input', 'keyup'])
        e.addEventListener(t, (ev) => __keys.push({ t, k: ev.key ?? ev.data, trusted: ev.isTrusted, shift: !!ev.shiftKey }), true);
      'ok'`);
    const sample = "Ab1!+é";
    countFb(await ok("type", { text: sample, delay_ms: 15 }));
    const v = JSON.parse(await js("document.querySelector('#email').value"));
    expect(v === sample, `value=${JSON.stringify(v)}`);
    const keys = JSON.parse(JSON.parse(await js("JSON.stringify(__keys)")));
    const downs = keys.filter((k) => k.t === "keydown");
    expect(downs.map((k) => k.k).join("").startsWith("Ab1!+"), `keydowns: ${downs.map((k) => k.k).join(",")}`);
    expect(keys.filter((k) => k.t === "keyup").length >= 5, "missing keyups");
    expect(keys.filter((k) => k.t === "input").length >= 6, "missing input events");
    expect(downs.find((k) => k.k === "A").shift && downs.find((k) => k.k === "!").shift, "shift not set for A / !");
    return `${downs.length} keydowns, ${downs.filter((k) => k.trusted).length} trusted`;
  });

  await step("type mode=paste inserts without key events", async () => {
    await js("__keys.length = 0; 'ok'");
    await ok("type", { text: "zz", mode: "paste" });
    const v = JSON.parse(await js("document.querySelector('#email').value"));
    const downs = JSON.parse(JSON.parse(await js("JSON.stringify(__keys.filter(k => k.t === 'keydown'))")));
    expect(v.endsWith("zz") && downs.length === 0, `value=${v} keydowns=${downs.length}`);
    // Leave a valid email so later form submits pass browser validation.
    await js("document.querySelector('#email').value = 'hermes@x.io'; 'ok'");
  });

  await step("screenshot returns image + saved file", async () => {
    const r = await ok("screenshot");
    expect(r.img && r.img.data.length > 1000, "no image");
    const dims = r.txt.match(/Screenshot (\d+)x(\d+)/);
    expect(dims, r.txt);
    return `${dims[1]}x${dims[2]}`;
  });

  await step("click by screenshot coordinates", async () => {
    const p = JSON.parse(JSON.parse(await js("const r=document.querySelector('button[type=submit]').getBoundingClientRect(); JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,w:innerWidth})")));
    const shot = await ok("screenshot");
    const s = Number(shot.txt.match(/Screenshot (\d+)x/)[1]) / p.w;
    await js("document.getElementById('out').textContent=''");
    const c = countFb(await ok("click", { x: Math.round(p.x * s), y: Math.round(p.y * s) }));
    const t = await js("document.getElementById('out').textContent");
    const top = await js(`(() => { const e = document.elementsFromPoint(${p.x}, ${p.y}); return e.slice(0,4).map(x => x.tagName + (x.id ? '#' + x.id : '') + (x.src ? '[' + x.src.slice(0,40) + ']' : '')).join(' > ') })()`);
    expect(t.includes("submitted"), `out=${t}\nclick said: ${c.txt}\nelements at point: ${top}`);
  });

  await step("navigate + scroll + off-screen ref click", async () => {
    const r = await ok("navigate", { url: base + "/long" });
    expect(r.txt.includes("Long"), r.txt);
    countFb(await ok("scroll", { direction: "down", amount: 5 }));
    const y = await js("scrollY");
    expect(Number(y) > 0, `scrollY=${y}`);
    const f = await ok("find", { query: "Far button" });
    countFb(await ok("click", { ref: refOf(f.txt, "Far button") }));
    const t = await ok("find", { query: "clicked far" });
    expect(t.txt.includes("clicked far"), t.txt);
  });

  await step("navigate back", async () => {
    const r = await ok("navigate", { url: "back" });
    expect(r.txt.includes("Hermes fixture"), r.txt);
  });

  await step("stale ref gives a clear error", async () => {
    const r = await call("click", { ref: "ref_99999" });
    expect(r.isError && /not found/.test(r.txt), r.txt);
  });

  await step("confirm dialog: reported, blocks other tools, Cancel works", async () => {
    await ok("navigate", { url: base + "/dialog" });
    const c = await ok("click", { ref: refOf((await ok("find", { query: "Confirm delete" })).txt, "Confirm delete") });
    expect(/confirm dialog/.test(c.txt) && c.txt.includes("Delete everything?"), `click said: ${c.txt}`);
    const blocked = await ok("read_page", { filter: "interactive" });
    expect(/dialog is open/.test(blocked.txt), `read_page while dialog open: ${blocked.txt.slice(0, 200)}`);
    const l = await ok("tabs_list");
    expect(/confirm dialog open/.test(l.txt), "tabs_list does not flag the dialog");
    const h = await ok("handle_dialog", { accept: false });
    expect(/Dismissed the confirm dialog/.test(h.txt), h.txt);
    const out = JSON.parse(await js("out.textContent"));
    expect(out === "confirm:false", `out=${out}`);
  });

  await step("prompt dialog answered with text", async () => {
    const c = await ok("click", { ref: refOf((await ok("find", { query: "Ask name" })).txt, "Ask name") });
    expect(/prompt dialog/.test(c.txt) && /default answer: "anon"/.test(c.txt), c.txt);
    await ok("handle_dialog", { accept: true, prompt_text: "Hermes" });
    const out = JSON.parse(await js("out.textContent"));
    expect(out === "prompt:Hermes", `out=${out}`);
  });

  await step("alert dialog dismissed, page continues", async () => {
    const c = await ok("click", { ref: refOf((await ok("find", { query: "Show alert" })).txt, "Show alert") });
    expect(/alert dialog/.test(c.txt) && c.txt.includes("Saved!"), c.txt);
    await ok("handle_dialog", {});
    const out = JSON.parse(await js("out.textContent"));
    expect(out === "alerted", `out=${out}`);
    const none = await call("handle_dialog", {});
    expect(none.isError && /No JavaScript dialog/.test(none.txt), `second handle_dialog: ${none.txt}`);
  });

  await step("cross-origin iframe: outline, form_input, click by frame ref", async () => {
    await ok("navigate", { url: base + "/frames" });
    await new Promise((r) => setTimeout(r, 800)); // let the iframe load
    const outline = (await ok("read_page", { filter: "interactive" })).txt;
    expect(/--- iframe f\d+: http:\/\/localhost/.test(outline), `no iframe section:\n${outline}`);
    const accept = refOf(outline, 'button "Accept all"');
    const nick = refOf(outline, 'textbox "Nickname"');
    expect(/^f\d+:ref_\d+$/.test(accept) && /^f\d+:ref_\d+$/.test(nick), `refs: ${accept} ${nick}`);
    await ok("form_input", { ref: nick, value: "Neo" });
    const c = countFb(await ok("click", { ref: accept }));
    const f = await ok("find", { query: "accepted:" });
    const m = f.txt.match(/accepted:Neo:(true|false)/);
    expect(m && /\(iframe f\d+\)/.test(f.txt), `find: ${f.txt}\nclick said: ${c.txt}`);
    return `click trusted=${m[1]}${/in iframe/.test(c.txt) ? " (debugger click with frame offset)" : ""}`;
  });

  await step("type into a field inside the iframe", async () => {
    const outline = (await ok("read_page", { filter: "interactive" })).txt;
    const nick = refOf(outline, 'textbox "Nickname"');
    await ok("click", { ref: nick });
    await ok("key", { keys: "ctrl+a Backspace" });
    countFb(await ok("type", { text: "Trinity" }));
    const f = await ok("find", { query: "Nickname" });
    expect(f.txt.includes('value="Trinity"'), f.txt);
  });

  await step("closed agent tab never falls back to another tab", async () => {
    const r = await ok("tabs_create", { url: base + "/long" });
    const tmp = Number(r.txt.match(/Tab (\d+)/)[1]);
    await ok("tabs_close", { tabId: tmp });
    const j = await call("javascript", { code: "location.href" });
    expect(j.isError && /was closed/.test(j.txt), `after closing the agent tab, javascript returned: ${j.txt}`);
    await ok("tabs_select", { tabId });
    const href = JSON.parse(await js("location.href"));
    expect(href.startsWith(base), `back on the test tab? ${href}`);
  });

  if (background) {
    await step("the user's tab stayed in front the whole time", async () => {
      await ok("tabs_select", { tabId });
      const l = await ok("tabs_list");
      expect(activeIds(l.txt) === userActive, `active tabs changed: ${activeIds(l.txt)} (was ${userActive})`);
      expect(!l.txt.split("\n").find((x) => x.startsWith(`${tabId} `))?.includes("[active]"), "agent tab became active");
    });

    await step("activity overlay is on the page but invisible to the agent", async () => {
      const present = JSON.parse(await js("!!document.querySelector('hermes-overlay')"));
      expect(present === true, "no overlay element");
      const outline = (await ok("read_page", { filter: "all" })).txt + (await ok("get_page_text")).txt;
      expect(!/Hermes is using|Stop/.test(outline), "overlay text leaked into read_page/get_page_text");
      await ok("screenshot");
      const vis = JSON.parse(await js("getComputedStyle(document.querySelector('hermes-overlay')).visibility"));
      expect(vis === "visible", `overlay left hidden after screenshot: ${vis}`);
    });
  }

  await step("real website: example.com", async () => {
    await ok("navigate", { url: "example.com" });
    const t = await ok("get_page_text");
    expect(/Example Domain/.test(t.txt), t.txt.slice(0, 300));
  });

  await step("tabs_close", async () => { await ok("tabs_close", { tabId }); });

  console.log(`(${fallbacks} actions used the fallback path)`);
  await client.close();
  await new Promise((r) => setTimeout(r, 500)); // let the port free up
}

for (const m of MODES) await runMode(m);
console.log(`\nTOTAL: ${total.pass} passed, ${total.fail} failed`);
site.close();
process.exit(total.fail ? 1 : 0);
