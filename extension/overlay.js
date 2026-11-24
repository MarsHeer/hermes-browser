// Hermes Browser: on-page activity overlay. Injected into the top frame of the
// agent's tab (isolated world). Shows where the agent's cursor "is", what it is
// acting on, a working glow, and a Stop / Resume pill. Never intercepts input
// except on the pill's button, and is hidden during screenshots.
(() => {
  if (globalThis.__hermesOverlay) return;

  const host = document.createElement("hermes-overlay");
  host.setAttribute("data-hermes-skip", "");
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block;";
  const root = host.attachShadow({ mode: "closed" });

  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  .wrap { position: fixed; inset: 0; pointer-events: none; font: 500 12px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .glow {
    position: fixed; inset: 0; border-radius: 0; opacity: 0; transition: opacity .35s ease;
    box-shadow: inset 0 0 0 2px rgba(139, 92, 246, .85), inset 0 0 28px 4px rgba(139, 92, 246, .28);
  }
  .on .glow { opacity: 1; animation: breathe 2.4s ease-in-out infinite; }
  @keyframes breathe { 50% { box-shadow: inset 0 0 0 2px rgba(167, 139, 250, .95), inset 0 0 40px 8px rgba(139, 92, 246, .38); } }
  .paused .glow { opacity: 1; animation: none; box-shadow: inset 0 0 0 2px rgba(245, 158, 11, .9), inset 0 0 24px 4px rgba(245, 158, 11, .25); }

  .hl {
    position: fixed; left: 0; top: 0; width: 0; height: 0; border-radius: 8px; opacity: 0;
    border: 2px solid #8b5cf6; background: rgba(139, 92, 246, .10);
    box-shadow: 0 0 0 4px rgba(139, 92, 246, .18);
    transition: transform .32s cubic-bezier(.2,.8,.2,1), width .32s cubic-bezier(.2,.8,.2,1), height .32s cubic-bezier(.2,.8,.2,1), opacity .25s ease;
  }
  .hl.show { opacity: 1; }

  .cursor { position: fixed; left: 0; top: 0; opacity: 0; transition: opacity .25s ease; will-change: transform; }
  .cursor.show { opacity: 1; }
  .cursor svg { display: block; filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
  .tag {
    position: absolute; left: 18px; top: 20px; white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis;
    padding: 4px 9px; border-radius: 999px; color: #fff; background: #7c3aed;
    box-shadow: 0 2px 8px rgba(76, 29, 149, .35);
  }
  .tag b { font-weight: 650; }

  .ripple {
    position: fixed; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
    border: 2px solid #8b5cf6; background: rgba(139, 92, 246, .18); pointer-events: none;
    animation: ripple .55s ease-out forwards;
  }
  @keyframes ripple { from { transform: scale(.35); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }

  .pill {
    position: fixed; left: 50%; bottom: 18px; transform: translate(-50%, 12px); opacity: 0;
    display: flex; align-items: center; gap: 10px; padding: 7px 8px 7px 12px; border-radius: 999px;
    color: #f5f3ff; background: rgba(30, 27, 46, .92); backdrop-filter: blur(8px);
    box-shadow: 0 8px 28px rgba(0,0,0,.28), 0 0 0 1px rgba(255,255,255,.08) inset;
    transition: opacity .3s ease, transform .3s ease; pointer-events: none;
  }
  .on .pill, .paused .pill { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
  .pill.top { bottom: auto; top: 18px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #a78bfa; box-shadow: 0 0 0 0 rgba(167,139,250,.7); animation: ping 1.6s infinite; }
  .paused .dot { background: #f59e0b; animation: none; }
  @keyframes ping { 70% { box-shadow: 0 0 0 7px rgba(167,139,250,0); } 100% { box-shadow: 0 0 0 0 rgba(167,139,250,0); } }
  .msg { max-width: 46vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .msg small { color: #c4b5fd; font-weight: 450; margin-left: 6px; }
  button {
    all: unset; cursor: pointer; padding: 5px 11px; border-radius: 999px; font: 600 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #fff; background: #dc2626;
  }
  button:hover { background: #b91c1c; }
  .paused button { background: #7c3aed; }
  .paused button:hover { background: #6d28d9; }

  @media (prefers-reduced-motion: reduce) {
    .cursor, .hl, .pill, .glow { transition: none !important; animation: none !important; }
    .ripple { display: none; }
  }
</style>
<div class="wrap">
  <div class="glow"></div>
  <div class="hl"></div>
  <div class="cursor">
    <svg width="22" height="24" viewBox="0 0 22 24" aria-hidden="true">
      <path d="M2 2 L2 19.5 L6.6 15.4 L9.7 22.3 L13 20.8 L9.9 14 L16.2 14 Z" fill="#7c3aed" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>
    </svg>
    <div class="tag"><b>Hermes</b></div>
  </div>
  <div class="pill" role="status">
    <span class="dot"></span>
    <span class="msg">Hermes is using this tab</span>
    <button type="button">Stop</button>
  </div>
</div>`;

  const $ = (s) => root.querySelector(s);
  const wrap = $(".wrap"), hl = $(".hl"), cursor = $(".cursor"), tag = $(".tag"), msg = $(".msg"), btn = $("button"), pill = $(".pill");

  // The pill takes clicks (its Stop button), so it must never sit on what the
  // agent is about to click: move it to the other edge when the target is near.
  function keepPillClear(x, y, rect) {
    const p = pill.getBoundingClientRect();
    const near = (px, py) => px > p.left - 40 && px < p.right + 40 && py > p.top - 40 && py < p.bottom + 40;
    const hit = near(x, y) || (rect && rect.x < p.right + 40 && rect.x + rect.w > p.left - 40 && rect.y < p.bottom + 40 && rect.y + rect.h > p.top - 40);
    if (hit) pill.classList.toggle("top");
  }
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let pos = null;          // cursor position (viewport CSS px)
  let idleTimer = null;
  let hlTimer = null;
  let isPaused = false;

  const mount = () => { if (!host.isConnected) (document.body || document.documentElement).appendChild(host); };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function setLabel(label) {
    tag.innerHTML = label ? `<b>Hermes</b> · ${esc(label)}` : "<b>Hermes</b>";
    msg.innerHTML = isPaused ? "Hermes is paused" : `Hermes is using this tab${label ? `<small>${esc(label)}</small>` : ""}`;
  }

  function active() {
    mount();
    wrap.classList.toggle("on", !isPaused);
    clearTimeout(idleTimer);
    // No word from the agent for a while: fade back out.
    idleTimer = setTimeout(() => {
      wrap.classList.remove("on");
      cursor.classList.remove("show");
      hl.classList.remove("show");
    }, 7000);
  }

  function moveCursor(x, y) {
    const from = pos || { x: x - 60, y: y + 40 };
    const dist = Math.hypot(x - from.x, y - from.y);
    const ms = reduced ? 0 : Math.round(Math.min(650, Math.max(220, 160 + dist * 0.45)));
    if (!pos) { // first appearance: start just off the target, no transition
      cursor.style.transition = "none";
      cursor.style.transform = `translate(${from.x}px, ${from.y}px)`;
      cursor.getBoundingClientRect();
    }
    cursor.style.transition = `transform ${ms}ms cubic-bezier(.2,.8,.2,1), opacity .25s ease`;
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    cursor.classList.add("show");
    pos = { x, y };
    return new Promise((r) => setTimeout(r, ms));
  }

  function highlight(rect) {
    clearTimeout(hlTimer);
    if (!rect || rect.w <= 0 || rect.h <= 0) { hl.classList.remove("show"); return; }
    const pad = 4;
    hl.style.transform = `translate(${rect.x - pad}px, ${rect.y - pad}px)`;
    hl.style.width = `${rect.w + pad * 2}px`;
    hl.style.height = `${rect.h + pad * 2}px`;
    hl.classList.add("show");
    hlTimer = setTimeout(() => hl.classList.remove("show"), 2200);
  }

  // The focused element's box, following focus into same-document iframes' boxes.
  function focusRect() {
    let el = document.activeElement;
    if (!el || el === document.body) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: isPaused ? "resume" : "pause" }).catch(() => {});
  });

  globalThis.__hermesOverlay = {
    // One agent action. {label, x, y, rect, from, click, useFocus}. Resolves once the
    // cursor has arrived, so the real event lands under it. Returns the new position.
    async act(o = {}) {
      active();
      if (o.from && !pos) pos = o.from;
      setLabel(o.label || "");
      let rect = o.rect || null;
      let x = o.x, y = o.y;
      if (o.useFocus) {
        rect = rect || focusRect();
        if (rect && x == null) { x = rect.x + Math.min(rect.w - 4, 14); y = rect.y + rect.h / 2; }
      }
      if (x != null && y != null) keepPillClear(x, y, rect);
      highlight(rect);
      if (x != null && y != null) await moveCursor(x, y);
      else cursor.classList.toggle("show", !!pos);
      return pos;
    },
    click(x, y) {
      if (reduced) return;
      const r = document.createElement("div");
      r.className = "ripple";
      r.style.left = `${x}px`;
      r.style.top = `${y}px`;
      wrap.appendChild(r);
      setTimeout(() => r.remove(), 600);
    },
    status(label) { active(); setLabel(label || ""); },
    setPaused(p) {
      isPaused = !!p;
      mount();
      wrap.classList.toggle("paused", isPaused);
      wrap.classList.toggle("on", false);
      btn.textContent = isPaused ? "Resume" : "Stop";
      setLabel("");
      if (!isPaused) active();
    },
    // Screenshots must show the page, not us.
    hide() { host.style.visibility = "hidden"; },
    show() { host.style.visibility = ""; },
    done() { clearTimeout(idleTimer); idleTimer = setTimeout(() => { wrap.classList.remove("on"); cursor.classList.remove("show"); }, 2500); },
  };
})();
