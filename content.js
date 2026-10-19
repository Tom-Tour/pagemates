// Script injecté dans chaque page : envoie notre curseur, nos clics et notre surlignage
// au moteur (background), et dessine ceux des autres personnes présentes sur la page.
//
// Les positions ne sont jamais envoyées en pixels : chacun a sa taille d'écran, son zoom,
// ses polices. On envoie l'élément visé (chemin dans le DOM) et la position relative dans
// sa boîte ; chez l'autre, le curseur se pose sur le même élément. Si l'élément n'existe
// pas chez lui (contenu personnalisé…), on retombe sur une position approximative.
//
// Le surlignage est envoyé comme citation (texte + quelques caractères avant et après),
// à la manière des annotations web : ça résiste aux différences de mise en page.
//
// Le contenu des champs de saisie n'est jamais lu ni envoyé.

(() => {
  if (window.top !== window || window.__pagemates) return;
  window.__pagemates = true;

  const port = browser.runtime.connect({ name: "page" });
  let config = { showCursors: true, shareCursor: true, shareSelection: true };
  let peers = new Map(); // id → { name, color, cur, curAt, click, sel }
  let lastUrl = "";
  let lastSel = ""; // dernier surlignage envoyé

  // --- Adresse de la page (les sites à une seule page changent d'URL sans recharger) ---

  function reportUrl() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    port.postMessage({ t: "url", url: location.href });
    lastSel = "";
  }
  reportUrl();
  setInterval(reportUrl, 1000);

  // --- Ancrage sur un élément ----------------------------------------------------

  // Les id générés par les frameworks (« :r3: », « ember1234 », « a1b2c3d4e5 ») changent
  // d'un chargement à l'autre : on ne s'y accroche pas
  function stableId(id) {
    return id.length <= 64 && !/[:\s]|\d{3,}|[0-9a-f]{8,}/i.test(id);
  }

  // Empreinte courte du texte de l'élément : sert à vérifier qu'on retombe sur le même
  // élément, sans envoyer le texte lui-même
  const hintCache = new WeakMap();
  function hint(el) {
    if (hintCache.has(el)) return hintCache.get(el);
    let h = 0;
    if (el.childElementCount < 30) {
      const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
      h = 0x811c9dc5;
      for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
      h >>>= 0;
    }
    hintCache.set(el, h);
    return h;
  }

  function anchorFor(el, clientX, clientY) {
    const steps = [];
    let node = el;
    let root = "";
    while (node && node !== document.body && node !== document.documentElement && steps.length < 60) {
      if (node.id && stableId(node.id) && document.getElementById(node.id) === node) {
        root = node.id;
        break;
      }
      const parent = node.parentElement;
      if (!parent) break;
      let i = 0;
      for (let s = node.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === node.localName) i++;
      steps.push([node.localName, i]);
      node = parent;
    }
    steps.reverse();
    const r = el.getBoundingClientRect();
    const doc = document.documentElement;
    return {
      r: root,
      p: steps,
      x: r.width ? clamp((clientX - r.left) / r.width) : 0.5,
      y: r.height ? clamp((clientY - r.top) / r.height) : 0.5,
      h: hint(el),
      // Repli : position dans la page entière
      fx: clamp((clientX + scrollX) / Math.max(1, doc.scrollWidth)),
      fy: clamp((clientY + scrollY) / Math.max(1, doc.scrollHeight)),
    };
  }

  // → { el, exact } ou null
  function resolve(a) {
    let node = a.r ? document.getElementById(a.r) : document.body;
    if (!node) return null;
    for (const [tag, index] of a.p) {
      let i = 0;
      let next = null;
      for (let c = node.firstElementChild; c; c = c.nextElementSibling) {
        if (c.localName === tag && i++ === index) {
          next = c;
          break;
        }
      }
      if (!next) return null;
      node = next;
    }
    return { el: node, exact: !a.h || hint(node) === a.h };
  }

  const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));

  // Élément visé, en ignorant notre propre calque
  function targetAt(e) {
    const el = e.composedPath ? e.composedPath()[0] : e.target;
    if (!(el instanceof Element) || el === host || host?.contains(el)) return null;
    return el.closest?.("svg") && el.localName !== "svg" ? el.closest("svg") : el;
  }

  // --- Envoi de notre curseur ----------------------------------------------------

  const CURSOR_EVERY = 50; // ms : 20 positions par seconde au plus
  let pending = null;
  let lastSent = 0;
  let timer = null;
  let hidden = true;

  function sharing() {
    return config.shareCursor && peers.size > 0;
  }

  function flushCursor() {
    timer = null;
    if (!pending) return;
    lastSent = Date.now();
    port.postMessage({ t: "cur", a: pending });
    pending = null;
  }

  addEventListener(
    "pointermove",
    (e) => {
      if (!sharing() || e.pointerType === "touch") return;
      const el = targetAt(e);
      if (!el) return;
      pending = anchorFor(el, e.clientX, e.clientY);
      hidden = false;
      const wait = CURSOR_EVERY - (Date.now() - lastSent);
      if (wait <= 0) flushCursor();
      else timer ??= setTimeout(flushCursor, wait);
    },
    { passive: true, capture: true }
  );

  function hideCursor() {
    if (hidden || !sharing()) return;
    hidden = true;
    clearTimeout(timer);
    timer = null;
    pending = null;
    port.postMessage({ t: "cur", a: null });
  }
  document.addEventListener("mouseleave", hideCursor);
  addEventListener("blur", hideCursor);
  document.addEventListener("visibilitychange", () => document.hidden && hideCursor());

  addEventListener(
    "pointerdown",
    (e) => {
      if (!sharing() || e.button !== 0) return;
      const el = targetAt(e);
      if (el) port.postMessage({ t: "click", a: anchorFor(el, e.clientX, e.clientY) });
    },
    { passive: true, capture: true }
  );

  // --- Surlignage (citation de texte) ------------------------------------------------

  const QUOTE_MAX = 1000;
  const CONTEXT = 32;
  const SKIP = new Set(["script", "style", "noscript", "textarea", "template", "select", "option"]);

  // Tout le texte de la page, avec la position de chaque nœud texte dans l'ensemble
  function textIndex() {
    const nodes = [];
    const starts = [];
    let text = "";
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || SKIP.has(p.localName) || p.isContentEditable) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push(n);
      starts.push(text.length);
      text += n.data;
    }
    return { nodes, starts, text };
  }

  function offsetOf(index, node, offset) {
    if (node.nodeType !== Node.TEXT_NODE) {
      // Bord de sélection posé sur un élément : premier nœud texte qui suit
      const child = node.childNodes[offset];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      walker.currentNode = child ?? node;
      const next = child?.nodeType === Node.TEXT_NODE ? child : walker.nextNode();
      if (!next) return -1;
      node = next;
      offset = 0;
    }
    const i = index.nodes.indexOf(node);
    return i < 0 ? -1 : index.starts[i] + Math.min(offset, node.data.length);
  }

  function inField(node) {
    const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return !!el?.closest?.("input, textarea, [contenteditable=''], [contenteditable=true]");
  }

  function currentQuote() {
    const s = getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return null;
    const range = s.getRangeAt(0);
    if (inField(range.startContainer) || inField(range.endContainer)) return null;
    const index = textIndex();
    const start = offsetOf(index, range.startContainer, range.startOffset);
    const end = offsetOf(index, range.endContainer, range.endOffset);
    if (start < 0 || end <= start) return null;
    const exact = index.text.slice(start, Math.min(end, start + QUOTE_MAX));
    if (!exact.trim()) return null;
    return {
      exact,
      prefix: index.text.slice(Math.max(0, start - CONTEXT), start),
      suffix: index.text.slice(start + exact.length, start + exact.length + CONTEXT),
    };
  }

  let selTimer = null;
  document.addEventListener("selectionchange", () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      if (!config.shareSelection || !peers.size) return;
      const q = currentQuote();
      const key = q ? q.prefix + "\u0000" + q.exact : "";
      if (key === lastSel) return;
      lastSel = key;
      port.postMessage({ t: "sel", q });
    }, 300);
  });

  function resendSelection() {
    lastSel = "";
    document.dispatchEvent(new Event("selectionchange"));
  }

  // Retrouve une citation dans notre page → Range, ou null
  function findQuote(q) {
    const index = textIndex();
    let best = -1;
    let bestScore = -1;
    for (let at = index.text.indexOf(q.exact), n = 0; at >= 0 && n < 100; at = index.text.indexOf(q.exact, at + 1), n++) {
      const score = common(index.text.slice(Math.max(0, at - q.prefix.length), at), q.prefix, true) +
        common(index.text.slice(at + q.exact.length, at + q.exact.length + q.suffix.length), q.suffix, false);
      if (score > bestScore) [best, bestScore] = [at, score];
    }
    if (best < 0) return null;
    const range = document.createRange();
    const place = (pos, setter) => {
      let i = 0;
      while (i + 1 < index.starts.length && index.starts[i + 1] <= pos) i++;
      range[setter](index.nodes[i], pos - index.starts[i]);
    };
    place(best, "setStart");
    place(best + q.exact.length, "setEnd");
    return range;
  }

  // Nombre de caractères communs, en partant du bord collé à la citation
  function common(a, b, fromEnd) {
    let n = 0;
    while (n < a.length && n < b.length) {
      const ca = fromEnd ? a[a.length - 1 - n] : a[n];
      const cb = fromEnd ? b[b.length - 1 - n] : b[n];
      if (ca !== cb) break;
      n++;
    }
    return n;
  }

  // --- Calque d'affichage --------------------------------------------------------

  // Un hôte en Shadow DOM fermé, styles posés en ligne : le CSS du site ne nous touche
  // pas, et la politique de sécurité (CSP) du site ne bloque rien.
  let host = null;
  let layer = null;

  function css(el, styles) {
    for (const [k, v] of Object.entries(styles)) el.style.setProperty(k, v, "important");
    return el;
  }

  function div(styles, parent = layer) {
    const d = css(document.createElement("div"), styles);
    parent?.appendChild(d);
    return d;
  }

  function ensureLayer() {
    if (host?.isConnected) return;
    host = document.createElement("pagemates-layer");
    css(host, {
      all: "initial",
      position: "fixed",
      inset: "0",
      "pointer-events": "none",
      "z-index": "2147483647",
      overflow: "hidden",
      contain: "strict",
    });
    const shadow = host.attachShadow({ mode: "closed" });
    layer = div({ position: "absolute", inset: "0", font: "12px/1.3 system-ui, sans-serif" }, shadow);
    document.documentElement.appendChild(host);
  }

  function makeCursor(peer) {
    const box = div({ position: "absolute", left: "0", top: "0", "will-change": "transform", display: "none" });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "22");
    svg.setAttribute("viewBox", "0 0 18 22");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M1 1 L1 18 L5.5 13.8 L8.6 21 L11.6 19.7 L8.6 12.6 L15 12.6 Z");
    path.setAttribute("stroke", "white");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    css(svg, { display: "block", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.35))" });
    box.appendChild(svg);
    const label = div(
      {
        position: "absolute",
        left: "14px",
        top: "18px",
        padding: "1px 6px",
        "border-radius": "8px",
        color: "white",
        "white-space": "nowrap",
        "font-weight": "600",
        "box-shadow": "0 1px 2px rgba(0,0,0,.3)",
      },
      box
    );
    const arrow = div({ position: "absolute", left: "-2px", top: "-2px", "font-size": "14px", display: "none" }, box);
    peer.ui = { box, path, label, arrow, sel: [] };
    paintPeer(peer);
  }

  function paintPeer(peer) {
    if (!peer.ui) return;
    peer.ui.path.setAttribute("fill", peer.color);
    css(peer.ui.label, { background: peer.color });
    peer.ui.label.textContent = peer.name;
    css(peer.ui.arrow, { color: peer.color });
  }

  // Position à l'écran d'un ancrage → { x, y, exact } ou null
  function place(a, cache) {
    if (!cache.el || !cache.el.isConnected) Object.assign(cache, resolve(a) ?? { el: null, exact: false });
    const doc = document.documentElement;
    if (cache.el) {
      const r = cache.el.getBoundingClientRect();
      if (r.width || r.height) return { x: r.left + a.x * r.width, y: r.top + a.y * r.height, exact: cache.exact, rect: r };
    }
    return { x: a.fx * doc.scrollWidth - scrollX, y: a.fy * doc.scrollHeight - scrollY, exact: false };
  }

  const IDLE_FADE = 20000;
  let frame = 0;

  function draw() {
    frame = 0;
    if (!config.showCursors || !peers.size) return;
    if (host && !host.isConnected) document.documentElement.appendChild(host); // page réécrite par le site
    const W = innerWidth;
    const H = innerHeight;
    const now = Date.now();
    for (const peer of peers.values()) {
      if (!peer.ui) continue;
      const { box, arrow, label } = peer.ui;
      if (peer.cur) {
        const p = place(peer.cur, peer.curCache);
        const off = p.y < 0 ? "▲" : p.y > H ? "▼" : p.x < 0 ? "◀" : p.x > W ? "▶" : "";
        const x = Math.min(W - 20, Math.max(2, p.x));
        const y = Math.min(H - 40, Math.max(2, p.y));
        css(box, {
          display: "block",
          transform: `translate(${x}px, ${y}px)`,
          opacity: String(now - peer.curAt > IDLE_FADE ? 0.35 : off || !p.exact ? 0.55 : 1),
        });
        arrow.textContent = off;
        css(arrow, { display: off ? "block" : "none" });
        css(peer.ui.box.firstChild, { visibility: off ? "hidden" : "visible" });
        css(label, { top: off ? "0" : "18px" });
      } else {
        css(box, { display: "none" });
      }
      drawSelection(peer);
    }
    frame = requestAnimationFrame(draw);
  }

  function drawSelection(peer) {
    const rects = peer.selRange ? [...peer.selRange.getClientRects()].slice(0, 80) : [];
    const pool = peer.ui.sel;
    while (pool.length < rects.length) pool.push(div({ position: "absolute", "border-radius": "2px" }));
    pool.forEach((d, i) => {
      const r = rects[i];
      if (!r || r.bottom < 0 || r.top > innerHeight) return css(d, { display: "none" });
      css(d, {
        display: "block",
        left: r.left + "px",
        top: r.top + "px",
        width: r.width + "px",
        height: r.height + "px",
        background: peer.color + "40",
        "border-bottom": `2px solid ${peer.color}`,
      });
    });
  }

  function schedule() {
    if (!frame && config.showCursors && peers.size) frame = requestAnimationFrame(draw);
  }

  function showClick(peer, a) {
    if (!config.showCursors) return;
    ensureLayer();
    const cache = {};
    const p = place(a, cache);
    if (p.rect && p.exact) {
      const r = p.rect;
      const outline = div({
        position: "absolute",
        left: r.left - 3 + "px",
        top: r.top - 3 + "px",
        width: r.width + 6 + "px",
        height: r.height + 6 + "px",
        border: `2px solid ${peer.color}`,
        "border-radius": "6px",
        "box-shadow": `0 0 0 4px ${peer.color}33`,
      });
      outline.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1200, easing: "ease-in" }).onfinish = () => outline.remove();
    }
    const ring = div({
      position: "absolute",
      left: p.x - 15 + "px",
      top: p.y - 15 + "px",
      width: "30px",
      height: "30px",
      "border-radius": "50%",
      border: `3px solid ${peer.color}`,
    });
    ring.animate(
      [
        { transform: "scale(.3)", opacity: 1 },
        { transform: "scale(1.6)", opacity: 0 },
      ],
      { duration: 650, easing: "ease-out" }
    ).onfinish = () => ring.remove();
  }

  function clearPeer(peer) {
    peer.ui?.box.remove();
    peer.ui?.sel.forEach((d) => d.remove());
    peer.ui = null;
  }

  // --- Messages du moteur ----------------------------------------------------------

  port.onMessage.addListener((msg) => {
    switch (msg.t) {
      case "config": {
        config = msg.config;
        if (!config.shareSelection && lastSel) {
          lastSel = "";
          port.postMessage({ t: "sel", q: null });
        }
        if (!config.showCursors) {
          for (const peer of peers.values()) clearPeer(peer);
        } else {
          for (const peer of peers.values()) if (!peer.ui) (ensureLayer(), makeCursor(peer));
        }
        schedule();
        break;
      }
      case "peers": {
        const next = new Map();
        for (const { id, name, color } of msg.list) {
          const peer = peers.get(id) ?? { cur: null, curAt: 0, curCache: {}, selRange: null };
          peer.name = name;
          peer.color = color;
          next.set(id, peer);
          if (config.showCursors) {
            ensureLayer();
            if (!peer.ui) makeCursor(peer);
            else paintPeer(peer);
          }
        }
        for (const [id, peer] of peers) if (!next.has(id)) clearPeer(peer);
        const arrived = [...next.keys()].some((id) => !peers.has(id));
        peers = next;
        // Quelqu'un vient d'arriver : on lui montre notre surlignage en cours
        if (arrived) resendSelection();
        if (!peers.size) host?.remove();
        schedule();
        break;
      }
      case "cur": {
        const peer = peers.get(msg.id);
        if (!peer) return;
        peer.cur = msg.a;
        peer.curAt = Date.now();
        peer.curCache = {};
        schedule();
        break;
      }
      case "click": {
        const peer = peers.get(msg.id);
        if (peer) showClick(peer, msg.a);
        break;
      }
      case "sel": {
        const peer = peers.get(msg.id);
        if (!peer) return;
        peer.selRange = msg.q ? findQuote(msg.q) : null;
        schedule();
        break;
      }
    }
  });
})();
