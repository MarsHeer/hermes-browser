// Injected into pages (isolated world) by background.js. Defines helpers once per
// frame; refs persist across calls because the isolated world persists.
(() => {
  if (globalThis.__hermesPage) return;

  const state = { next: 1, byEl: new WeakMap(), byRef: new Map() };

  function refFor(el) {
    let r = state.byEl.get(el);
    if (!r) {
      r = "ref_" + state.next++;
      state.byEl.set(el, r);
      state.byRef.set(r, new WeakRef(el));
    }
    return r;
  }

  function getEl(ref) {
    const el = state.byRef.get(ref)?.deref();
    if (!el || !el.isConnected) throw new Error(`${ref} not found (the page changed). Call read_page or find again.`);
    return el;
  }

  const INPUT_ROLES = {
    checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button",
    image: "button", range: "slider", search: "searchbox", email: "textbox", tel: "textbox",
    url: "textbox", text: "textbox", password: "textbox", number: "spinbutton", file: "button",
  };

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case "a": return el.hasAttribute("href") ? "link" : "generic";
      case "button": return "button";
      case "input": return INPUT_ROLES[(el.type || "text").toLowerCase()] || "textbox";
      case "select": return el.multiple ? "listbox" : "combobox";
      case "textarea": return "textbox";
      case "img": return "img";
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "heading";
      case "nav": return "navigation";
      case "main": return "main";
      case "header": return "banner";
      case "footer": return "contentinfo";
      case "aside": return "complementary";
      case "form": return "form";
      case "dialog": return "dialog";
      case "summary": return "button";
      case "option": return "option";
      case "li": return "listitem";
      case "table": return "table";
      case "label": return "label";
      case "p": return "paragraph";
      default: return el.isContentEditable ? "textbox" : "generic";
    }
  }

  const clip = (s, n = 100) => {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };

  function nameOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return clip(aria);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
      if (t.trim()) return clip(t);
    }
    if (el.labels && el.labels.length) {
      // Label text without the text of controls nested inside it (e.g. <select> options).
      const c = el.labels[0].cloneNode(true);
      c.querySelectorAll("select, textarea, input, option").forEach((n) => n.remove());
      const t = clip(c.textContent);
      if (t) return t;
    }
    for (const a of ["alt", "title", "placeholder"]) {
      const v = el.getAttribute(a);
      if (v) return clip(v);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && ["button", "submit", "reset"].includes(el.type)) return clip(el.value);
    if (tag === "input" || tag === "textarea") return "";
    // Containers are named only by aria; their full text would swamp find().
    if (CONTAINERS.has(roleOf(el))) return "";
    return clip(el.innerText || el.textContent || "");
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "input", "select", "textarea", "summary", "option"].includes(tag)) {
      return !(tag === "a" && !el.hasAttribute("href")) && !(tag === "input" && el.type === "hidden");
    }
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return true;
    const role = el.getAttribute("role");
    if (role && /^(button|link|checkbox|radio|switch|tab|menuitem\w*|option|combobox|textbox|searchbox|slider|spinbutton|treeitem)$/.test(role)) return true;
    if (el.hasAttribute("onclick")) return true;
    const ti = el.getAttribute("tabindex");
    return ti !== null && Number(ti) >= 0;
  }

  const CONTAINERS = new Set(["navigation", "main", "banner", "contentinfo", "complementary", "form", "dialog", "table", "list", "region", "generic"]);
  const STRUCTURAL = new Set(["heading", "img", "navigation", "main", "banner", "contentinfo", "complementary", "form", "dialog", "table", "paragraph"]);

  function isVisible(el) {
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function* walk(root) {
    for (const el of root.querySelectorAll("*")) {
      yield el;
      if (el.shadowRoot) yield* walk(el.shadowRoot);
    }
  }

  function describe(el) {
    const role = roleOf(el);
    const name = nameOf(el);
    const bits = [role];
    if (name) bits.push(JSON.stringify(name));
    const tag = el.tagName.toLowerCase();
    if (role === "heading") bits.push(`level=${tag[1]}`);
    if (tag === "a" && el.href) bits.push(`href=${clip(el.getAttribute("href"), 80)}`);
    if ((tag === "input" || tag === "textarea") && !["checkbox", "radio", "button", "submit", "reset"].includes(el.type)) {
      if (el.type === "password") bits.push(el.value ? 'value="(hidden)"' : 'value=""');
      else bits.push(`value=${JSON.stringify(clip(el.value, 80))}`);
      const ph = el.getAttribute("placeholder");
      if (ph && clip(ph) !== name) bits.push(`placeholder=${JSON.stringify(clip(ph, 60))}`);
    }
    if (tag === "select") bits.push(`selected=${JSON.stringify(clip([...el.selectedOptions].map((o) => o.text.trim()).join(", "), 80))}`);
    if (el.type === "checkbox" || el.type === "radio" || el.getAttribute("aria-checked")) {
      bits.push(`checked=${el.checked ?? el.getAttribute("aria-checked")}`);
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") bits.push("disabled");
    if (el.getAttribute("aria-expanded")) bits.push(`expanded=${el.getAttribute("aria-expanded")}`);
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) bits.push("offscreen");
    return `${bits.join(" ")} [${refFor(el)}]`;
  }

  function collect(filter) {
    const lines = [];
    lines.interactive = new Set();
    for (const el of walk(document)) {
      const interactive = isInteractive(el);
      if (!interactive) {
        if (filter === "interactive") continue;
        const role = roleOf(el);
        if (!STRUCTURAL.has(role)) continue;
        if (role === "paragraph" && !nameOf(el)) continue;
      }
      if (!isVisible(el)) continue;
      const line = describe(el);
      lines.push(line);
      if (interactive) lines.interactive.add(line);
    }
    return lines;
  }

  function truncate(text, max) {
    return text.length > max ? text.slice(0, max) + `\n[truncated at ${max} chars]` : text;
  }

  // ---- Fallback input (used when chrome.debugger is blocked on the tab, e.g. by
  // another extension's iframe). These are synthetic DOM events, not OS-level input.

  // Topmost element at a point, skipping UI injected by other extensions
  // (password managers etc.): extension iframes, and custom-element wrappers that
  // extensions attach straight to <html>/<body>, often with a closed shadow root.
  const EXT_IFRAME = 'iframe[src^="chrome-extension:"], iframe[src^="moz-extension:"]';
  function isExtensionUi(e) {
    if (e.tagName === "IFRAME" && /^(chrome|moz)-extension:/.test(e.src || "")) return true;
    const topLevel = e.parentElement === document.body || e.parentElement === document.documentElement;
    if (topLevel && e.tagName.includes("-") && (!e.shadowRoot || e.shadowRoot.querySelector(EXT_IFRAME))) return true;
    return topLevel && !!e.querySelector?.(EXT_IFRAME);
  }
  function elementAt(x, y) {
    const els = document.elementsFromPoint(x, y);
    return els.find((e) => !isExtensionUi(e) && !e.closest?.("[data-hermes-skip]")) || document.body;
  }

  function fireMouse(el, x, y, button = "left", double = false, mods = {}) {
    const btn = { left: 0, middle: 1, right: 2 }[button] ?? 0;
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: btn, buttons: btn === 0 ? 1 : btn === 2 ? 2 : 4, ...mods };
    const P = (t) => el.dispatchEvent(new PointerEvent(t, { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    const M = (t, extra = {}) => el.dispatchEvent(new MouseEvent(t, { ...base, ...extra }));
    P("pointerover"); M("mouseover"); P("pointermove"); M("mousemove");
    const rounds = double ? 2 : 1;
    for (let i = 1; i <= rounds; i++) {
      P("pointerdown"); M("mousedown", { detail: i });
      if (i === 1 && el.focus && document.activeElement !== el) el.focus({ preventScroll: true });
      P("pointerup"); M("mouseup", { detail: i, buttons: 0 });
      if (button === "left") {
        // el.click() runs default actions (links, checkboxes, submit buttons).
        if (typeof el.click === "function" && !mods.ctrlKey && !mods.metaKey && !mods.shiftKey) el.click();
        else M("click", { detail: i, buttons: 0 });
      } else if (button === "right") M("contextmenu", { buttons: 0 });
      else M("auxclick", { detail: i, buttons: 0 });
    }
    if (double) M("dblclick", { detail: 2, buttons: 0 });
  }

  function modsFrom(str) {
    const s = String(str || "").toLowerCase();
    return { ctrlKey: /ctrl|control/.test(s), altKey: /alt|option/.test(s), shiftKey: /shift/.test(s), metaKey: /meta|cmd|command|win|super/.test(s) };
  }

  function editable(el) {
    return el && (el.isContentEditable || (el.tagName === "TEXTAREA") ||
      (el.tagName === "INPUT" && !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/i.test(el.type)));
  }

  function insertText(text) {
    const el = document.activeElement;
    if (!editable(el)) throw new Error("No focused text field. Click a field first.");
    if (document.execCommand("insertText", false, text)) return;
    if (el.isContentEditable) throw new Error("Could not insert text into this editor.");
    let s, e;
    try { s = el.selectionStart; e = el.selectionEnd; } catch {}
    if (s == null) s = e = el.value.length;
    const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, el.value.slice(0, s) + text + el.value.slice(e));
    try { el.setSelectionRange(s + text.length, s + text.length); } catch {}
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  const FOCUSABLE = "a[href],button,input:not([type=hidden]),select,textarea,[tabindex]:not([tabindex='-1']),[contenteditable='']";

  function pressKey(combo) {
    const parts = combo.split("+");
    const name = parts.pop();
    const mods = modsFrom(parts.join("+"));
    const lname = name.toLowerCase();
    const KEYNAMES = { enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape", backspace: "Backspace", delete: "Delete", space: " ", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown" };
    const key = KEYNAMES[lname] || (name.length === 1 ? (mods.shiftKey ? name.toUpperCase() : name) : name);
    const el = document.activeElement || document.body;
    const init = { key, bubbles: true, cancelable: true, composed: true, ...mods };
    const proceed = el.dispatchEvent(new KeyboardEvent("keydown", init));
    if (proceed) {
      const plainChar = key.length === 1 && !mods.ctrlKey && !mods.metaKey && !mods.altKey;
      if (plainChar) { el.dispatchEvent(new KeyboardEvent("keypress", init)); if (editable(el)) insertText(key); }
      else if ((mods.ctrlKey || mods.metaKey) && lname === "a") {
        if (el.select) el.select(); else document.execCommand("selectAll");
      } else if (key === "Backspace" || key === "Delete") {
        if (editable(el)) document.execCommand(key === "Backspace" ? "delete" : "forwardDelete");
      } else if (key === "Enter") {
        el.dispatchEvent(new KeyboardEvent("keypress", init));
        if (el.tagName === "TEXTAREA" || el.isContentEditable) insertText("\n");
        else if (el.tagName === "INPUT" && el.form) el.form.requestSubmit();
        else if (/^(BUTTON|A|SUMMARY)$/.test(el.tagName)) el.click();
      } else if (key === "Tab") {
        const all = [...document.querySelectorAll(FOCUSABLE)].filter((e) => !e.disabled && e.getClientRects().length);
        const i = all.indexOf(el);
        all[(i + (mods.shiftKey ? -1 : 1) + all.length) % all.length]?.focus();
      } else if ((key === "Home" || key === "End") && el.setSelectionRange) {
        const p = key === "Home" ? 0 : el.value.length;
        try { el.setSelectionRange(p, p); } catch { /* email/number inputs have no selection API */ }
      }
    }
    (document.activeElement || el).dispatchEvent(new KeyboardEvent("keyup", init));
  }

  globalThis.__hermesPage = {
    clickRef(ref, button, double, modifiers) {
      const el = getEl(ref);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const r = el.getBoundingClientRect();
      fireMouse(el, r.left + r.width / 2, r.top + r.height / 2, button, double, modsFrom(modifiers));
      return describe(el);
    },
    clickAt(x, y, button, double, modifiers) {
      const el = elementAt(x, y);
      fireMouse(el, x, y, button, double, modsFrom(modifiers));
      return describe(el);
    },
    hoverAt(x, y) {
      const el = elementAt(x, y);
      for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) {
        el.dispatchEvent(new (t.startsWith("pointer") ? PointerEvent : MouseEvent)(t, { bubbles: !t.endsWith("enter"), clientX: x, clientY: y, composed: true }));
      }
      return describe(el);
    },
    insertText,
    // Fallback per-key typing: keydown/keypress/input/keyup for each character.
    async typeKeys(text, delayMs) {
      for (const ch of text) {
        if (ch === "\n" || ch === "\r") pressKey("Enter");
        else if (ch === "\t") pressKey("Tab");
        else {
          const el = document.activeElement || document.body;
          const init = { key: ch, bubbles: true, cancelable: true, composed: true, shiftKey: /[A-Z~!@#$%^&*()_+{}|:"<>?]/.test(ch) };
          if (el.dispatchEvent(new KeyboardEvent("keydown", init))) {
            el.dispatchEvent(new KeyboardEvent("keypress", init));
            insertText(ch);
          }
          (document.activeElement || el).dispatchEvent(new KeyboardEvent("keyup", init));
        }
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
    },
    pressKeys(keys, repeat) {
      const seq = keys.trim().split(/\s+/).filter(Boolean);
      for (let r = 0; r < repeat; r++) for (const c of seq) pressKey(c);
    },
    scrollAt(x, y, dx, dy) {
      let el = x == null ? null : elementAt(x, y);
      while (el && el !== document.body) {
        const s = getComputedStyle(el);
        if ((dy && /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight) ||
            (dx && /(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth)) break;
        el = el.parentElement;
      }
      (el && el !== document.body ? el : window).scrollBy({ left: dx, top: dy, behavior: "instant" });
    },


    snapshot(filter = "all", maxChars = 40000) {
      const header = `Page: ${document.title}\nURL: ${clip(location.href, 300)}\nViewport: ${innerWidth}x${innerHeight}, scrollY=${Math.round(scrollY)} of ${document.documentElement.scrollHeight}\n`;
      const lines = collect(filter);
      return truncate(header + (lines.length ? lines.map((l) => "- " + l).join("\n") : "(no matching elements)"), maxChars);
    },

    // Outline lines for this frame only (used for iframes). Frames with no
    // viewport (hidden, 0x0 trackers) report nothing.
    frameLines(filter = "all") {
      if (!innerWidth || !innerHeight) return { url: location.href, lines: [] };
      return { url: location.href, lines: collect(filter) };
    },

    // Matching outline lines for this frame, interactive elements first.
    findLines(query) {
      if (!innerWidth || !innerHeight) return [];
      const q = String(query).toLowerCase();
      const all = collect("all");
      return all.filter((l) => l.toLowerCase().includes(q))
        .sort((a, b) => all.interactive.has(b) - all.interactive.has(a));
    },

    // Where the child <iframe> showing `url` sits in this frame's viewport (its
    // content box), after scrolling it into view. Matches by URL, then by origin.
    iframeRect(url) {
      const norm = (u) => { try { const x = new URL(u, location.href); x.hash = ""; return x.href; } catch { return u; } };
      const origin = (u) => { try { return new URL(u, location.href).origin; } catch { return null; } };
      const frames = [...document.querySelectorAll("iframe, frame")].filter((f) => f.getClientRects().length);
      const current = (f) => { try { return f.contentWindow.location.href; } catch { return null; } }; // same-origin only
      let match = frames.filter((f) => norm(current(f) || f.src) === norm(url));
      if (!match.length) match = frames.filter((f) => f.src && origin(f.src) === origin(url));
      if (!match.length) return null;
      const f = match[0];
      f.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      const r = f.getBoundingClientRect();
      return { x: r.left + f.clientLeft, y: r.top + f.clientTop };
    },

    find(query) {
      const q = String(query).toLowerCase();
      const all = collect("all");
      // Interactive matches first: they are what the agent usually wants to act on.
      const hits = all.filter((l) => l.toLowerCase().includes(q))
        .sort((a, b) => all.interactive.has(b) - all.interactive.has(a));
      if (!hits.length) return `No elements matching "${query}".`;
      return hits.slice(0, 25).map((l) => "- " + l).join("\n") + (hits.length > 25 ? `\n(${hits.length - 25} more)` : "");
    },

    text(maxChars = 40000) {
      const root = document.querySelector("main, article, [role=main]") || document.body;
      let t = root.innerText || "";
      if (root !== document.body && t.trim().length < 200) t = document.body.innerText || "";
      return truncate(`Page: ${document.title}\nURL: ${clip(location.href, 300)}\n\n${t}`, maxChars);
    },

    // Scrolls the element into view and returns its center in viewport CSS pixels.
    point(ref) {
      const el = getEl(ref);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: describe(el), rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
    },

    // Box of a ref (no scrolling), for the activity overlay.
    rectOf(ref) {
      const el = getEl(ref);
      el.scrollIntoView({ block: "nearest", behavior: "instant" });
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, label: describe(el) };
    },

    // Box of the focused element in this frame (what typing goes into).
    focusRect() {
      let el = document.activeElement;
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, label: describe(el) };
    },

    formInput(ref, value) {
      const el = getEl(ref);
      const tag = el.tagName.toLowerCase();
      el.scrollIntoView({ block: "center", behavior: "instant" });
      el.focus?.();
      const fire = () => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      if (tag === "select") {
        const want = String(value);
        const opt = [...el.options].find((o) => o.value === want) ||
                    [...el.options].find((o) => o.text.trim().toLowerCase() === want.toLowerCase());
        if (!opt) throw new Error(`No option "${want}". Options: ${[...el.options].map((o) => o.text.trim()).join(" | ")}`);
        el.value = opt.value;
        fire();
        return `Selected "${opt.text.trim()}" in ${ref}`;
      }
      if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) {
        const want = value === true || value === "true" || value === 1 || value === "1";
        if (el.checked !== want) el.click();
        return `${ref} checked=${el.checked}`;
      }
      if (el.isContentEditable) {
        el.textContent = String(value);
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
        return `Set text of ${ref}`;
      }
      if (tag === "input" || tag === "textarea") {
        // Native setter so frameworks like React notice the change.
        const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value));
        fire();
        return `Set ${ref} value`;
      }
      throw new Error(`${ref} (${tag}) is not a form field`);
    },
  };
})();
