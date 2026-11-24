// Hermes Browser: service worker. Connects to the local MCP bridge and executes
// tool calls against Chrome tabs using chrome.debugger (CDP) and chrome.scripting.

const DEFAULT_PORT = 8765;
let ws = null;
let status = "disconnected";
let pingTimer = null;
let reconnectTimer = null;
const shotScale = new Map(); // tabId -> CSS px per screenshot px
const attached = new Set();
const dialogs = new Map(); // tabId -> open JS dialog {type, message, defaultPrompt, url}
const dialogListeners = new Set(); // fn(tabId) called when a dialog opens
const focusFrame = new Map(); // tabId -> frameId the agent last clicked/filled in
let visuals = true; // show the on-page cursor/highlight overlay
let paused = false; // the user pressed Stop: refuse tool calls until Resume

// ---------------------------------------------------------------- connection

function setStatus(s) {
  status = s;
  const on = s === "connected";
  if (paused) return; // the STOP badge wins
  chrome.action.setBadgeText({ text: on ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: on ? "#16a34a" : "#6b7280" });
}

// Pairing: the bridge hands its token to this extension at POST /pair (it checks
// our chrome-extension:// Origin), so the user never pastes it. Asked when there
// is no token, and (rate-limited) while connecting keeps failing, in case the
// token changed. The popup's manual token field still works as a fallback.
let lastPairTry = 0;
let pairError = ""; // last reason pairing failed, shown in the popup

async function pairFromHost(force = false) {
  if (!force && Date.now() - lastPairTry < 5000) return false;
  lastPairTry = Date.now();
  try {
    const { port = DEFAULT_PORT } = await chrome.storage.local.get(["port"]);
    // POST so Chrome attaches our chrome-extension:// Origin, which the bridge checks.
    const res = await fetch(`http://127.0.0.1:${port}/pair`, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(3000) });
    const r = await res.json().catch(() => ({}));
    if (!r?.token) { pairError = r?.error === "forbidden" ? "the bridge doesn't recognise this extension's ID" : `bridge answered ${res.status}`; return false; }
    pairError = "";
    const cur = await chrome.storage.local.get(["token", "port"]);
    if (cur.token === r.token && cur.port === r.port) return false;
    // pairedAt marks this write as ours, so the storage listener doesn't reconnect twice.
    await chrome.storage.local.set({ token: r.token, port: r.port || DEFAULT_PORT, pairedAt: Date.now() });
    return true;
  } catch (e) {
    pairError = "no bridge running (start Hermes, or the Hermes Browser tunnel)";
    return false;
  }
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  let { port = DEFAULT_PORT, token = "", enabled = true } = await chrome.storage.local.get(["port", "token", "enabled"]);
  if (!enabled) return setStatus("disabled");
  if (!token && await pairFromHost(true)) ({ port = DEFAULT_PORT, token = "" } = await chrome.storage.local.get(["port", "token"]));
  if (!token) {
    // No bridge to pair with yet; look again shortly.
    setStatus("no-token");
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
    return;
  }
  if (ws) return; // another connect() started while we were pairing

  setStatus("connecting");
  const sock = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  ws = sock;
  let opened = false;

  sock.onopen = () => {
    opened = true;
    setStatus("connected");
    clearInterval(pingTimer);
    // Regular traffic keeps the MV3 service worker alive (Chrome 116+).
    pingTimer = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send('{"type":"ping"}'), 20000);
  };

  sock.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type !== "call") return;
    let reply;
    try {
      reply = { type: "result", id: msg.id, result: await runTool(msg.tool, msg.args || {}, msg.client) };
    } catch (e) {
      reply = { type: "result", id: msg.id, error: e?.message || String(e) };
    }
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(reply));
  };

  sock.onclose = async () => {
    clearInterval(pingTimer);
    if (ws === sock) ws = null;
    if (status !== "disabled" && status !== "no-token") setStatus("disconnected");
    clearTimeout(reconnectTimer);
    // Never got in: the bridge may be down, or the token may be stale. A browser
    // WebSocket can't tell those apart, so re-check the token now and then.
    if (!opened && await pairFromHost()) return reconnect();
    reconnectTimer = setTimeout(connect, 3000);
  };
  sock.onerror = () => {}; // onclose follows
}

function reconnect() {
  clearTimeout(reconnectTimer);
  if (ws) { const old = ws; ws = null; try { old.close(); } catch {} }
  connect();
}

chrome.alarms.create("hermes-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === "hermes-keepalive" && connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || changes.pairedAt) return; // pairing writes reconnect themselves
  if (changes.visuals) visuals = changes.visuals.newValue !== false;
  if (changes.paused && !!changes.paused.newValue !== paused) { paused = !!changes.paused.newValue; showPaused(); }
  if (changes.port || changes.token || changes.enabled) reconnect();
});
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "status") {
    chrome.storage.local.get(["port", "pairedAt"]).then(({ port = DEFAULT_PORT, pairedAt }) => sendResponse({ status, port, paired: !!pairedAt, pairError, paused }));
    return true;
  }
  // Stop / Resume, from the on-page pill or the popup.
  if (msg?.type === "pause") { setPaused(true); sendResponse({ ok: true }); }
  if (msg?.type === "resume") { setPaused(false); sendResponse({ ok: true }); }
  if (msg?.type === "reconnect") { reconnect(); sendResponse({ ok: true }); }
  if (msg?.type === "pair") {
    pairFromHost(true).then((changed) => { reconnect(); sendResponse({ ok: changed }); });
    return true;
  }
});
connect();

// ---------------------------------------------------------------- helpers

const text = (t) => ({ content: [{ type: "text", text: t }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each connected agent (a local Hermes, the cloud tunnel, a test...) has its own
// current tab, so one agent's tabs_select never redirects another's calls.
// Once an agent has a tab it never silently moves: if that tab disappears, tools
// fail until it picks one explicitly. And it never adopts the user's front tab on
// its own: it opens a tab, or the user's tab is selected on purpose.
const agents = new Map(); // client id -> { tab, lost }
function agentFor(client) {
  const key = client || "default";
  if (!agents.has(key)) agents.set(key, { tab: null, lost: null });
  return agents.get(key);
}
const agentTabs = () => [...agents.values()].map((a) => a.tab).filter((t) => t != null);

async function resolveTab(tabId, ag) {
  if (tabId != null) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw new Error(`No tab with id ${tabId}. Use tabs_list.`);
    ag.tab = t.id;
    ag.lost = null;
    return t;
  }
  if (ag.tab != null) {
    const t = await chrome.tabs.get(ag.tab).catch(() => null);
    if (t) return t;
    ag.lost = ag.tab;
    ag.tab = null;
  }
  if (ag.lost != null) {
    throw new Error(`The agent's tab (${ag.lost}) was closed. Pick a tab explicitly: tabs_list then pass tabId or use tabs_select, or tabs_create.`);
  }
  throw new Error("You don't have a tab yet. Use tabs_create to open one, or tabs_list + tabs_select to work in a tab the user points you to.");
}

// The agent works in its tab without bringing it to the front, so the user can
// keep using the browser. Input goes through the debugger, which reaches
// background tabs; focus emulation makes the page behave as if it had focus
// (focus/blur, :focus, document.hasFocus) so typing lands where it should.
const focusEmulated = new Set();
async function prepare(tab) {
  if (focusEmulated.has(tab.id)) return;
  try {
    await cdp(tab.id, "Emulation.setFocusEmulationEnabled", { enabled: true });
    focusEmulated.add(tab.id);
  } catch { /* debugger blocked: page-level fallbacks don't need it */ }
}

// ---------------------------------------------------------------- overlay
// The on-page cursor / highlight / "Hermes is using this tab" pill (overlay.js).
// Purely cosmetic: failures (chrome:// pages, closed tabs) are ignored.

const cursorPos = new Map(); // tabId -> last cursor point, so it continues after navigation
chrome.storage.local.get(["visuals", "paused"]).then((s) => { visuals = s.visuals !== false; paused = !!s.paused; showPaused(); });

async function overlay(tabId, method, ...args) {
  if (!visuals || tabId == null) return null;
  const call = () => chrome.scripting.executeScript({
    target: { tabId },
    func: (m, a) => (globalThis.__hermesOverlay ? globalThis.__hermesOverlay[m](...a) : "__missing"),
    args: [method, args],
  });
  try {
    let [{ result }] = await call();
    if (result === "__missing") {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["overlay.js"] });
      if (paused) await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.__hermesOverlay?.setPaused(true) });
      [{ result }] = await call();
    }
    return result;
  } catch {
    return null;
  }
}

// Show an action: glow + pill label, cursor glides to the point, element outlined.
async function showAct(tabId, opts) {
  const pos = await overlay(tabId, "act", { ...opts, from: cursorPos.get(tabId) });
  if (pos) cursorPos.set(tabId, pos);
}

// Box of a ref in top-viewport coordinates (adds the iframe's offset), or null.
async function refRect(tabId, { frameId, ref }) {
  try {
    const r = await pageIn(tabId, frameId, "rectOf", ref);
    if (!frameId) return r;
    const off = await frameOffset(tabId, frameId);
    return off ? { ...r, x: r.x + off.x, y: r.y + off.y } : null;
  } catch { return null; }
}

// Outline whatever has focus (where typing goes) and park the cursor at it.
async function showFocus(tabId, label) {
  if (!visuals) return;
  const frameId = focusFrame.get(tabId) || 0;
  let r = await pageIn(tabId, frameId, "focusRect").catch(() => null);
  if (r && frameId) {
    const off = await frameOffset(tabId, frameId).catch(() => null);
    r = off ? { ...r, x: r.x + off.x, y: r.y + off.y } : null;
  }
  await showAct(tabId, r ? { label, rect: r, x: r.x + Math.min(r.w - 4, 14), y: r.y + r.h / 2 } : { label });
}

function setPaused(p) {
  paused = !!p;
  chrome.storage.local.set({ paused });
  showPaused();
}
async function showPaused() {
  chrome.action.setBadgeText({ text: paused ? "STOP" : status === "connected" ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: paused ? "#d97706" : "#16a34a" });
  for (const t of agentTabs()) await overlay(t, "setPaused", paused);
}
const PAUSED_MSG = "The user paused browser control with the Stop button. Don't retry: tell the user, and wait until they click Resume (on the page or in the extension popup).";

chrome.debugger.onDetach.addListener((src) => { attached.delete(src.tabId); dialogs.delete(src.tabId); focusEmulated.delete(src.tabId); });
chrome.tabs.onRemoved.addListener((id) => {
  focusEmulated.delete(id);
  cursorPos.delete(id);
  attached.delete(id);
  shotScale.delete(id);
  dialogs.delete(id);
  focusFrame.delete(id);
  for (const a of agents.values()) if (a.tab === id) { a.lost = id; a.tab = null; }
});
// Chrome can swap a tab's contents into a new tab id (prerendering, discarding).
// Follow it so the agent keeps its tab.
chrome.tabs.onReplaced.addListener((addedId, removedId) => {
  for (const a of agents.values()) {
    if (a.tab === removedId) a.tab = addedId;
    if (a.lost === removedId) { a.lost = null; a.tab = addedId; }
  }
  attached.delete(removedId);
  dialogs.delete(removedId);
});

// Native alert/confirm/prompt/beforeunload dialogs freeze the page. CDP reports
// them (Page domain), and handle_dialog answers them.
chrome.debugger.onEvent.addListener((src, method, params) => {
  if (method === "Page.javascriptDialogOpening") {
    dialogs.set(src.tabId, params);
    for (const l of dialogListeners) l(src.tabId);
  } else if (method === "Page.javascriptDialogClosed") {
    dialogs.delete(src.tabId);
  }
});

function dialogNotice(tabId) {
  const d = dialogs.get(tabId);
  if (!d) return "";
  if (d.type === "beforeunload") {
    return `The page on tab ${tabId} is asking to confirm leaving ("Leave site?"). The page is frozen until answered: ` +
      `call handle_dialog with accept=true to leave or accept=false to stay.`;
  }
  return `A JavaScript ${d.type} dialog is open on tab ${tabId}: "${d.message}"` +
    (d.type === "prompt" ? ` (default answer: "${d.defaultPrompt || ""}")` : "") +
    `. The page is frozen until it is answered: call handle_dialog with accept=true (OK) or accept=false (Cancel)` +
    (d.type === "prompt" ? ", plus prompt_text for the answer." : ".");
}

// Attach the debugger with the Page domain on so dialogs on this tab are seen.
// Best effort: if another extension blocks the debugger, dialogs go unseen.
async function watchTab(tabId) {
  if (attached.has(tabId)) return;
  await Promise.race([cdp(tabId, "Page.enable").catch(() => {}), sleep(1500)]);
}

// Errors from chrome.debugger are tagged so tools can fall back to page-level
// events. Common cause: another extension (password manager, etc.) injected an
// iframe into the page, which makes Chrome refuse debugger access to the tab.
function cdpError(e) {
  const err = new Error(`Debugger unavailable on this tab (${e.message})`);
  err.cdp = true;
  return err;
}

async function cdp(tabId, method, params = {}) {
  if (!attached.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (e) {
      if (!/already attached/i.test(e.message)) throw cdpError(e);
    }
    attached.add(tabId);
    // Subscribe to dialog events on every attach (also reports one already open).
    try { await chrome.debugger.sendCommand({ tabId }, "Page.enable"); } catch {}
  }
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (e) {
    throw cdpError(e);
  }
}

const FALLBACK_NOTE = " [fallback: page-level events, because the debugger is blocked on this tab, usually by another extension's frame]";

// Run the trusted CDP path; if the debugger is unavailable, run the page-level fallback.
async function withFallback(args, viaCdp, viaPage) {
  if (args._noCdp) return (await viaPage()) + FALLBACK_NOTE;
  try {
    return await viaCdp();
  } catch (e) {
    if (!e.cdp) throw e;
    return (await viaPage()) + FALLBACK_NOTE;
  }
}

// async + await so helpers that return promises (typeKeys) finish before we reply.
const callHelper = async (m, a) => {
  try { return { ok: true, value: await globalThis.__hermesPage[m](...a) }; }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
};

// Run a page.js helper in one frame (0 = top document).
async function pageIn(tabId, frameId, method, ...args) {
  const target = { tabId, frameIds: [frameId] };
  try {
    await chrome.scripting.executeScript({ target, files: ["page.js"] });
  } catch (e) {
    throw new Error(frameId
      ? `Cannot reach iframe f${frameId} (${e.message}). It may have navigated; call read_page again.`
      : `Cannot read this page (${e.message}). chrome:// pages and the Web Store are off-limits.`);
  }
  const [res] = await chrome.scripting.executeScript({ target, func: callHelper, args: [method, args] });
  if (!res?.result) throw new Error("Page script returned nothing (page may be navigating). Try again.");
  if (!res.result.ok) throw new Error(res.result.error);
  return res.result.value;
}
const page = (tabId, method, ...args) => pageIn(tabId, 0, method, ...args);

// Run a helper in every frame we can access. Frames that fail are skipped.
async function pageAllFrames(tabId, method, ...args) {
  const target = { tabId, allFrames: true };
  try { await chrome.scripting.executeScript({ target, files: ["page.js"] }); } catch {}
  let results = [];
  try { results = await chrome.scripting.executeScript({ target, func: callHelper, args: [method, args] }); } catch {}
  return results.filter((r) => r?.result?.ok).map((r) => ({ frameId: r.frameId, value: r.result.value }));
}

// Refs inside iframes look like "f12:ref_3"; top-document refs are plain "ref_3".
function parseRef(ref) {
  const m = /^f(\d+):(ref_\d+)$/.exec(String(ref).trim());
  return m ? { frameId: Number(m[1]), ref: m[2] } : { frameId: 0, ref: String(ref).trim() };
}
const frameRefs = (line, frameId) => (frameId ? line.replace(/\[(ref_\d+)\]/, `[f${frameId}:$1]`) : line);

// Offset of an iframe's viewport within the top viewport, in CSS px. Each
// ancestor locates the child <iframe> by URL and scrolls it into view.
async function frameOffset(tabId, frameId) {
  let frames;
  try { frames = await chrome.webNavigation.getAllFrames({ tabId }); } catch { return null; }
  let x = 0, y = 0;
  let cur = frames.find((f) => f.frameId === frameId);
  while (cur && cur.parentFrameId !== -1) {
    const parentId = cur.parentFrameId;
    const r = await pageIn(tabId, parentId, "iframeRect", cur.url).catch(() => null);
    if (!r) return null;
    x += r.x; y += r.y;
    cur = frames.find((f) => f.frameId === parentId);
  }
  return cur ? { x, y } : null;
}

function waitForLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpd); resolve(); };
    const onUpd = (id, info) => id === tabId && info.status === "complete" && done();
    const timer = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

async function settle(tabId) {
  await sleep(350);
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (t?.status === "loading") await waitForLoad(tabId, 10000);
}

async function tabSummary(tabId) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  return t ? `Tab ${t.id}: ${t.title} (${t.url})` : `Tab ${tabId} closed`;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function groupTab(tab) {
  try {
    const [g] = await chrome.tabGroups.query({ title: "Hermes", windowId: tab.windowId });
    if (g) await chrome.tabs.group({ tabIds: [tab.id], groupId: g.id });
    else {
      const gid = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
      await chrome.tabGroups.update(gid, { title: "Hermes", color: "purple" });
    }
  } catch { /* grouping is cosmetic */ }
}

// ---------------------------------------------------------------- input

const MOD_BITS = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, super: 4, shift: 8 };
function parseMods(str) {
  if (!str) return 0;
  return str.toLowerCase().split("+").reduce((m, p) => m | (MOD_BITS[p.trim()] || 0), 0);
}

const KEYS = {
  enter: ["Enter", "Enter", 13, "\r"], return: ["Enter", "Enter", 13, "\r"],
  tab: ["Tab", "Tab", 9], escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
  backspace: ["Backspace", "Backspace", 8], delete: ["Delete", "Delete", 46], insert: ["Insert", "Insert", 45],
  space: [" ", "Space", 32, " "],
  arrowup: ["ArrowUp", "ArrowUp", 38], up: ["ArrowUp", "ArrowUp", 38],
  arrowdown: ["ArrowDown", "ArrowDown", 40], down: ["ArrowDown", "ArrowDown", 40],
  arrowleft: ["ArrowLeft", "ArrowLeft", 37], left: ["ArrowLeft", "ArrowLeft", 37],
  arrowright: ["ArrowRight", "ArrowRight", 39], right: ["ArrowRight", "ArrowRight", 39],
  home: ["Home", "Home", 36], end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34],
};
for (let i = 1; i <= 12; i++) KEYS["f" + i] = ["F" + i, "F" + i, 111 + i];

function keyDef(name, shift) {
  const k = KEYS[name.toLowerCase()];
  if (k) return { key: k[0], code: k[1], vk: k[2], text: k[3] };
  if (name.length === 1) {
    const up = name.toUpperCase();
    const isLetter = /[a-z]/i.test(name), isDigit = /[0-9]/.test(name);
    const key = shift && isLetter ? up : name;
    return { key, code: isLetter ? "Key" + up : isDigit ? "Digit" + name : "", vk: isLetter || isDigit ? up.charCodeAt(0) : 0, text: key };
  }
  throw new Error(`Unknown key "${name}".`);
}

// US-layout physical key for each printable ASCII char: [code, vk, needsShift].
const SHIFTED = { "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/" };
const PUNCT = { "`": ["Backquote", 192], "-": ["Minus", 189], "=": ["Equal", 187], "[": ["BracketLeft", 219], "]": ["BracketRight", 221], "\\": ["Backslash", 220], ";": ["Semicolon", 186], "'": ["Quote", 222], ",": ["Comma", 188], ".": ["Period", 190], "/": ["Slash", 191], " ": ["Space", 32] };

function charKey(ch) {
  if (/[a-z]/.test(ch)) return { code: "Key" + ch.toUpperCase(), vk: ch.toUpperCase().charCodeAt(0), shift: false };
  if (/[A-Z]/.test(ch)) return { code: "Key" + ch, vk: ch.charCodeAt(0), shift: true };
  if (/[0-9]/.test(ch)) return { code: "Digit" + ch, vk: ch.charCodeAt(0), shift: false };
  if (PUNCT[ch]) return { code: PUNCT[ch][0], vk: PUNCT[ch][1], shift: false };
  if (SHIFTED[ch]) {
    const base = SHIFTED[ch];
    const k = /[0-9]/.test(base) ? { code: "Digit" + base, vk: base.charCodeAt(0) } : { code: PUNCT[base][0], vk: PUNCT[base][1] };
    return { ...k, shift: true };
  }
  return null; // not on a US keyboard (accents, emoji, CJK...)
}

// Type text one key at a time with real keyDown/keyUp events, like a person.
// progress.n counts characters fully typed, so a fallback can resume mid-text.
async function typeKeys(tabId, text, delayMs, progress = { n: 0 }) {
  for (const ch of text) { // for..of iterates code points, so emoji stay whole
    if (paused) throw new Error(`Stopped after ${progress.n} characters. ${PAUSED_MSG}`);
    if (ch === "\n" || ch === "\r") await pressCombo(tabId, "Enter");
    else if (ch === "\t") await pressCombo(tabId, "Tab");
    else {
      const k = charKey(ch);
      if (!k) {
        // Characters without a key: commit them like an IME would.
        await cdp(tabId, "Input.insertText", { text: ch });
      } else {
        const mods = k.shift ? 8 : 0;
        await cdp(tabId, "Input.dispatchKeyEvent", {
          type: "keyDown", key: ch, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
          modifiers: mods, text: ch, unmodifiedText: ch,
        });
        await cdp(tabId, "Input.dispatchKeyEvent", {
          type: "keyUp", key: ch, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: mods,
        });
      }
    }
    progress.n++;
    if (delayMs) await sleep(delayMs);
  }
}

async function pressCombo(tabId, combo) {
  const parts = combo.split("+");
  const keyName = parts.pop();
  const mods = parts.reduce((m, p) => m | (MOD_BITS[p.toLowerCase()] || 0), 0);
  const d = keyDef(keyName, mods & 8);
  const txt = mods & 7 ? undefined : d.text; // no text when ctrl/alt/meta held
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: txt ? "keyDown" : "rawKeyDown", key: d.key, code: d.code,
    windowsVirtualKeyCode: d.vk, nativeVirtualKeyCode: d.vk, modifiers: mods, text: txt, unmodifiedText: txt,
  });
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp", key: d.key, code: d.code, windowsVirtualKeyCode: d.vk, nativeVirtualKeyCode: d.vk, modifiers: mods,
  });
}

// Viewport point (top-document CSS px) for a ref or screenshot x/y. For refs in
// iframes it adds the frame's offset; if that can't be worked out, noOffset is
// set and callers use an in-frame page-level event instead.
async function targetPoint(tab, args) {
  if (args.ref) {
    const { frameId, ref } = parseRef(args.ref);
    const off = frameId ? await frameOffset(tab.id, frameId) : { x: 0, y: 0 };
    const p = await pageIn(tab.id, frameId, "point", ref);
    const ox = off?.x || 0, oy = off?.y || 0;
    return {
      ...p, localX: p.x, localY: p.y, x: p.x + ox, y: p.y + oy, frameId, ref, noOffset: !off,
      rect: p.rect && off ? { ...p.rect, x: p.rect.x + ox, y: p.rect.y + oy } : null,
    };
  }
  if (args.x == null || args.y == null) throw new Error("Provide ref, or both x and y.");
  const s = shotScale.get(tab.id) ?? 1;
  return { x: args.x * s, y: args.y * s, label: `(${args.x}, ${args.y})`, frameId: 0 };
}

// ---------------------------------------------------------------- tools

const tools = {
  async tabs_list(_args, ag) {
    const tabs = await chrome.tabs.query({});
    const groups = await chrome.tabGroups.query({ title: "Hermes" }).catch(() => []);
    const hermes = new Set(groups.map((g) => g.id));
    const lines = tabs.map((t) =>
      `${t.id}${t.id === ag.tab ? " (current)" : agentTabs().includes(t.id) ? " (another agent's)" : ""}${t.active ? " [active]" : ""}${hermes.has(t.groupId) ? " [Hermes]" : ""}` +
      `${dialogs.has(t.id) ? ` [${dialogs.get(t.id).type} dialog open: use handle_dialog]` : ""} | ${t.title} | ${t.url}`);
    return text(`Hermes Browser extension v${chrome.runtime.getManifest().version}\n` + (lines.join("\n") || "No tabs."));
  },

  async tabs_create({ url, focus }, ag) {
    if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
    // Don't pull the user away from what they're doing: open in the background,
    // unless they're already watching the agent's tab (or asked to see it).
    const [front] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const agentTab = ag.tab != null ? await chrome.tabs.get(ag.tab).catch(() => null) : null;
    const watching = !!front && front.id === agentTab?.id;
    const active = focus ?? watching;
    const tab = await chrome.tabs.create({
      url: url || "about:blank", active,
      ...(agentTab ? { windowId: agentTab.windowId, index: agentTab.index + 1 } : {}),
    });
    ag.tab = tab.id;
    ag.lost = null;
    await groupTab(tab);
    if (url) await waitForLoad(tab.id);
    await overlay(tab.id, "status", "Opened this tab");
    return text(`Created and selected${active ? "" : " (in the background; the user's tab stays in front)"}. ${await tabSummary(tab.id)}`);
  },

  async tabs_select({ tabId, focus }, ag) {
    const tab = await resolveTab(tabId, ag);
    if (focus) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return text(`Selected${focus ? " and brought to the front" : ""}. ${await tabSummary(tab.id)}`);
  },

  async tabs_close({ tabId }, ag) {
    await chrome.tabs.remove(tabId);
    return text(`Closed tab ${tabId}.`);
  },

  async navigate({ url, tabId }, ag) {
    const tab = await resolveTab(tabId, ag);
    const loaded = waitForLoad(tab.id);
    if (url === "back" || url === "forward") {
      const before = tab.url;
      try {
        await (url === "back" ? chrome.tabs.goBack(tab.id) : chrome.tabs.goForward(tab.id));
      } catch {
        // Chrome's back-button intervention skips entries the user never interacted
        // with; history.back()/forward() from the page still reaches them.
        await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: "MAIN",
          func: (dir) => (dir === "back" ? history.back() : history.forward()), args: [url],
        });
        await Promise.race([loaded, sleep(5000)]);
        const now = await chrome.tabs.get(tab.id);
        if (now.url === before) throw new Error(`No ${url === "back" ? "previous" : "next"} page in this tab's history.`);
      }
    } else {
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
      await chrome.tabs.update(tab.id, { url });
    }
    focusFrame.delete(tab.id);
    await loaded;
    const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
    await overlay(tab.id, "status", url === "back" || url === "forward" ? `Went ${url}` : `Opened ${host || "the page"}`);
    return text(`Navigated. ${await tabSummary(tab.id)}`);
  },

  async screenshot(args, ag) {
    const tab = await resolveTab(args.tabId, ag);
    const [{ result: vp }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: () => [innerWidth, innerHeight],
    }).catch(() => [{ result: null }]);
    // The debugger renders the tab even when it's in the background, so the user
    // can keep using another tab. captureVisibleTab (no debugger needed) only sees
    // the tab in front: it's the fallback where another extension blocks the debugger.
    const visible = async () => {
      const win = await chrome.windows.get(tab.windowId).catch(() => null);
      const now = await chrome.tabs.get(tab.id);
      if (!now.active || win?.state === "minimized") {
        throw new Error("Can't screenshot this tab while it's in the background: another extension blocks the debugger here, " +
          "and without it only the front tab can be captured. Use read_page / find / get_page_text, or tabs_select with focus=true to bring it to the front.");
      }
      try { return await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }); }
      catch (e) {
        if (!/MAX_CAPTURE|quota/i.test(e.message)) throw e;
        await sleep(600);
        return chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      }
    };
    await overlay(tab.id, "hide");
    let dataUrl;
    try {
      dataUrl = await withFallback(args,
        async () => {
          await prepare(tab);
          const shot = cdp(tab.id, "Page.captureScreenshot", { format: "png" });
          const { data } = await Promise.race([shot, sleep(8000).then(() => { throw cdpError(new Error("capture timed out")); })]);
          return "data:image/png;base64," + data;
        },
        visible);
    } finally {
      await overlay(tab.id, "show");
    }
    dataUrl = dataUrl.replace(FALLBACK_NOTE, "");
    await overlay(tab.id, "status", "Looked at the page");
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    // Work in CSS pixels; cap the long side so the image stays model-friendly.
    let [cssW, cssH] = vp || [bitmap.width, bitmap.height];
    const f = Math.min(1, 1568 / Math.max(cssW, cssH));
    const outW = Math.round(cssW * f), outH = Math.round(cssH * f);
    const canvas = new OffscreenCanvas(outW, outH);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, outW, outH);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.75 });
    shotScale.set(tab.id, cssW / outW);
    return {
      content: [
        { type: "image", data: toBase64(await blob.arrayBuffer()), mimeType: "image/jpeg" },
        { type: "text", text: `Screenshot ${outW}x${outH}. ${await tabSummary(tab.id)}. click/hover x,y use this image's pixels.` },
      ],
    };
  },

  async read_page({ filter = "all", max_chars = 40000, tabId }, ag) {
    const tab = await resolveTab(tabId, ag);
    await overlay(tab.id, "status", "Reading the page");
    let out = await page(tab.id, "snapshot", filter, max_chars);
    // Append visible iframes (cookie/consent banners, embedded forms, ...).
    const frames = (await pageAllFrames(tab.id, "frameLines", filter)).filter((f) => f.frameId !== 0 && f.value.lines.length);
    for (const f of frames) {
      if (out.length >= max_chars) { out += `\n[more iframes omitted: raise max_chars]`; break; }
      out += `\n--- iframe f${f.frameId}: ${f.value.url.slice(0, 120)} ---\n` + f.value.lines.map((l) => "- " + frameRefs(l, f.frameId)).join("\n");
    }
    return text(out.length > max_chars ? out.slice(0, max_chars) + `\n[truncated at ${max_chars} chars]` : out);
  },

  async find({ query, tabId }, ag) {
    const tab = await resolveTab(tabId, ag);
    await overlay(tab.id, "status", `Looking for “${query.slice(0, 40)}”`);
    const hits = [];
    for (const f of await pageAllFrames(tab.id, "findLines", query)) {
      for (const l of f.value) hits.push((f.frameId ? `(iframe f${f.frameId}) ` : "") + frameRefs(l, f.frameId));
    }
    // Top-document hits first (pageAllFrames returns the top frame first, but be explicit).
    hits.sort((a, b) => a.startsWith("(iframe") - b.startsWith("(iframe"));
    if (!hits.length) return text(`No elements matching "${query}".`);
    return text(hits.slice(0, 25).map((l) => "- " + l).join("\n") + (hits.length > 25 ? `\n(${hits.length - 25} more)` : ""));
  },

  async get_page_text({ max_chars = 40000, tabId }, ag) {
    const tab = await resolveTab(tabId, ag);
    await overlay(tab.id, "status", "Reading the page");
    return text(await page(tab.id, "text", max_chars));
  },

  async click(args, ag) {
    const tab = await resolveTab(args.tabId, ag);
    await prepare(tab);
    const button = args.button || "left";
    const verbing = args.double ? "Double-clicking" : button === "right" ? "Right-clicking" : "Clicking";
    const verb = args.double ? "Double-clicked" : "Clicked";
    const target = args.ref ? parseRef(args.ref) : { frameId: 0 };
    // A ref click via page-level events targets the element itself (in its frame),
    // so overlays can't steal it.
    const clickRefInPage = async () =>
      `${verb} ${await pageIn(tab.id, target.frameId, "clickRef", target.ref, button, !!args.double, args.modifiers || "")}.`;
    // Glide the on-page cursor to the target and outline it, then click under it.
    const show = async (p) => {
      if (p.noOffset) return;
      await showAct(tab.id, { label: `${verbing} ${p.label}`, x: p.x, y: p.y, rect: p.rect });
      overlay(tab.id, "click", p.x, p.y);
    };
    const msg = await withFallback(args,
      async () => {
        const p = await targetPoint(tab, args);
        if (p.noOffset) return (await clickRefInPage()) + " [page-level click: could not locate the iframe on screen]";
        await show(p);
        const modifiers = parseMods(args.modifiers);
        const base = { x: p.x, y: p.y, button, modifiers };
        await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, modifiers });
        for (let c = 1; c <= (args.double ? 2 : 1); c++) {
          await cdp(tab.id, "Input.dispatchMouseEvent", { ...base, type: "mousePressed", clickCount: c });
          await cdp(tab.id, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased", clickCount: c });
        }
        return `${verb} ${p.label}${p.frameId ? ` in iframe f${p.frameId}` : ""}.`;
      },
      async () => {
        const p = await targetPoint(tab, args).catch((e) => { if (args.ref) return { noOffset: true }; throw e; });
        await show(p);
        if (args.ref) return clickRefInPage();
        return `${verb} ${await page(tab.id, "clickAt", p.x, p.y, button, !!args.double, args.modifiers || "")}.`;
      });
    focusFrame.set(tab.id, target.frameId);
    await settle(tab.id);
    return text(`${msg} ${await tabSummary(tab.id)}`);
  },

  async hover(args, ag) {
    const tab = await resolveTab(args.tabId, ag);
    await prepare(tab);
    const p = await targetPoint(tab, args);
    if (!p.noOffset) await showAct(tab.id, { label: `Pointing at ${p.label}`, x: p.x, y: p.y, rect: p.rect });
    const inFrame = async () => p.frameId
      ? `Hovering ${await pageIn(tab.id, p.frameId, "hoverAt", p.localX, p.localY)}.`
      : `Hovering ${await page(tab.id, "hoverAt", p.x, p.y)}.`;
    const msg = await withFallback(args,
      async () => {
        if (p.noOffset) return inFrame();
        await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
        return `Hovering ${p.label}.`;
      },
      inFrame);
    return text(msg);
  },

  async type(args, ag) {
    const tab = await resolveTab(args.tabId, ag);
    await prepare(tab);
    const t = args.text;
    const paste = args.mode === "paste";
    const preview = [...t].length > 24 ? [...t].slice(0, 24).join("") + "…" : t;
    await showFocus(tab.id, `${paste ? "Pasting" : "Typing"} “${preview.replace(/\s+/g, " ")}”`);
    const delay = Math.max(0, Math.min(500, args.delay_ms ?? 0));
    const done = `Typed ${[...t].length} characters${paste ? " (pasted)" : " key by key"}.`;
    const progress = { n: 0 };
    const msg = await withFallback(args,
      async () => {
        if (paste) await cdp(tab.id, "Input.insertText", { text: t });
        else await typeKeys(tab.id, t, delay, progress);
        return done;
      },
      async () => {
        // Resume after whatever the debugger path already typed.
        const rest = [...t].slice(progress.n).join("");
        if (rest) await pageIn(tab.id, focusFrame.get(tab.id) || 0, paste ? "insertText" : "typeKeys", rest, delay);
        return done;
      });
    if (!paste && /[\n\r]/.test(t)) await settle(tab.id); // Enter may have submitted something
    return text(msg);
  },

  async key(args, ag) {
    const { keys, repeat = 1 } = args;
    const tab = await resolveTab(args.tabId, ag);
    await prepare(tab);
    const seq = keys.trim().split(/\s+/).filter(Boolean);
    for (const combo of seq) keyDef(combo.split("+").pop(), false); // validate before acting
    await showFocus(tab.id, `Pressing ${keys}${repeat > 1 ? ` ×${repeat}` : ""}`);
    const msg = await withFallback(args,
      async () => {
        for (let r = 0; r < repeat; r++) for (const combo of seq) await pressCombo(tab.id, combo);
        return `Pressed ${keys}${repeat > 1 ? ` x${repeat}` : ""}.`;
      },
      async () => { await pageIn(tab.id, focusFrame.get(tab.id) || 0, "pressKeys", keys, repeat); return `Pressed ${keys}${repeat > 1 ? ` x${repeat}` : ""}.`; });
    await settle(tab.id);
    return text(`${msg} ${await tabSummary(tab.id)}`);
  },

  async scroll(args, ag) {
    const { direction, amount = 3, x, y } = args;
    const tab = await resolveTab(args.tabId, ag);
    await prepare(tab);
    let px, py;
    if (x != null && y != null) {
      const s = shotScale.get(tab.id) ?? 1;
      px = x * s; py = y * s;
    } else {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => [innerWidth / 2, innerHeight / 2] });
      [px, py] = result;
    }
    const d = amount * 100;
    const dx = direction === "left" ? -d : direction === "right" ? d : 0;
    const dy = direction === "up" ? -d : direction === "down" ? d : 0;
    await showAct(tab.id, { label: `Scrolling ${direction}`, x: px, y: py });
    const msg = await withFallback(args,
      async () => { await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseWheel", x: px, y: py, deltaX: dx, deltaY: dy }); return `Scrolled ${direction} ${amount}.`; },
      async () => { await page(tab.id, "scrollAt", x != null ? px : null, py, dx, dy); return `Scrolled ${direction} ${amount}.`; });
    await sleep(300);
    return text(msg);
  },

  async form_input({ ref, value, tabId }, ag) {
    const tab = await resolveTab(tabId, ag);
    const t = parseRef(ref);
    focusFrame.set(tab.id, t.frameId);
    const r = await refRect(tab.id, t);
    if (r) await showAct(tab.id, { label: `Filling ${r.label}`, x: r.x + Math.min(r.w - 4, 14), y: r.y + r.h / 2, rect: r });
    return text(await pageIn(tab.id, t.frameId, "formInput", t.ref, value));
  },

  async handle_dialog({ accept = true, prompt_text, tabId }, ag) {
    // Default: the given tab, else the agent's tab if it has a dialog, else any tab with one.
    // Default: the agent's own tab. Never another agent's or the user's tab unasked.
    const tid = tabId ?? ag.tab;
    if (tid == null) throw new Error("No tab to act on.");
    const d = dialogs.get(tid);
    try {
      await cdp(tid, "Page.handleJavaScriptDialog", { accept: !!accept, ...(prompt_text != null ? { promptText: String(prompt_text) } : {}) });
    } catch (e) {
      throw new Error(d ? `Could not answer the dialog (${e.message}).` : "No JavaScript dialog is open on this tab.");
    }
    dialogs.delete(tid);
    await settle(tid);
    return text(`${accept ? "Accepted" : "Dismissed"} the ${d?.type || "JavaScript"} dialog${d?.message ? ` "${d.message}"` : ""}` +
      `${accept && prompt_text != null ? ` with answer "${prompt_text}"` : ""}. ${await tabSummary(tid)}`);
  },

  async javascript(args, ag) {
    const { code } = args;
    const tab = await resolveTab(args.tabId, ag);
    let out = await withFallback(args,
      async () => {
        const r = await cdp(tab.id, "Runtime.evaluate", {
          expression: code, awaitPromise: true, returnByValue: true, replMode: true, userGesture: true,
        });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        const v = r.result;
        return v.type === "undefined" ? "undefined" : "value" in v ? JSON.stringify(v.value, null, 2) : v.description || v.type;
      },
      async () => {
        // Main-world eval; subject to the page's CSP (some sites forbid eval).
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: "MAIN",
          func: async (src) => {
            try {
              const v = await (0, eval)(src);
              return { ok: true, out: v === undefined ? "undefined" : JSON.stringify(v, null, 2) ?? String(v) };
            } catch (e) { return { ok: false, error: String(e?.message || e) }; }
          },
          args: [code],
        });
        if (!res?.result?.ok) throw new Error(res?.result?.error || "Script failed");
        return res.result.out;
      });
    out = out?.replace(FALLBACK_NOTE, ""); // keep returned values clean
    if (out && out.length > 40000) out = out.slice(0, 40000) + "\n[truncated]";
    return text(out ?? "undefined");
  },
};

const NO_DIALOG_CHECK = new Set(["tabs_list", "tabs_create", "tabs_close", "handle_dialog"]);

async function runTool(name, args, client) {
  const fn = tools[name];
  if (!fn) throw new Error(`Unknown tool ${name}`);
  if (paused && name !== "tabs_list") throw new Error(PAUSED_MSG);
  const ag = agentFor(client);
  if (NO_DIALOG_CHECK.has(name)) return fn(args, ag);

  // A dialog already open freezes the page: say so instead of hanging.
  const tid = args.tabId ?? ag.tab;
  if (tid != null) {
    await watchTab(tid);
    if (dialogs.has(tid)) return text(dialogNotice(tid));
  }
  // If the action opens a dialog (e.g. a click on "Delete"), the page freezes and
  // the action never completes: report the dialog as soon as it appears.
  let off = () => {};
  const opened = new Promise((resolve) => {
    const l = (tabId) => {
      if (tabId === (args.tabId ?? ag.tab)) resolve(text(`The action opened a dialog. ${dialogNotice(tabId)}`));
    };
    dialogListeners.add(l);
    off = () => dialogListeners.delete(l);
  });
  try {
    return await Promise.race([fn(args, ag), opened]);
  } finally {
    off();
  }
}
