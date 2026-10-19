// Page script tests (content.js) in jsdom: anchoring, highlights, drawings, redraws.
// Internals are exposed by a test-only source transform. Run: node tests/page.test.cjs
const fs = require("fs");
const { JSDOM } = require("jsdom");

const SRC = fs.readFileSync(require("path").join(__dirname, "../content.js"), "utf8").replace(
  /\}\)\(\);\s*$/,
  "window.__test = { resolve, findQuote, anchorFor, currentQuote, stableId, mine, getPeers: () => peers, getCapture: () => capture, getInk: () => ink };\n})();"
);

function page(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url: "https://example.org/a", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const sent = [];
  const listeners = [];
  w.browser = { runtime: { connect: () => ({ postMessage: (m) => sent.push(m), onMessage: { addListener: (f) => listeners.push(f) } }) } };
  w.document.elementsFromPoint = () => [w.document.body];
  w.rafCount = 0;
  const raf = w.requestAnimationFrame.bind(w);
  w.requestAnimationFrame = (f) => (w.rafCount++, raf(f));
  w.Element.prototype.setPointerCapture = () => {};
  w.eval(SRC);
  return { w, d: w.document, sent, recv: (m) => listeners.forEach((f) => f(m)), T: w.__test };
}

(async () => {
let fails = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  " + x}`); if (!c) fails++; };

const ARTICLE = `
  <header><nav><a href="/">Accueil</a><a href="/b">B</a></nav></header>
  <main id="content">
    <h1>Paris</h1>
    <p>Paris est la capitale de la France et sa plus grande ville.</p>
    <p>La capitale de la France compte deux millions d'habitants.</p>
    <ul><li>Un</li><li>Deux</li><li><button>Trois</button></li></ul>
    <input id="pw" type="password" value="secret">
  </main>`;

// anchor → resolve on a different but equivalent page (extra banner before main, generated ids)
const A = page(ARTICLE);
const btn = A.d.querySelector("li:nth-child(3) button");
const anchor = A.T.anchorFor(btn, 0, 0);
check("anchor rooted on stable id", anchor.r === "content", JSON.stringify(anchor));
check("anchor path", JSON.stringify(anchor.p) === '[["ul",0],["li",2],["button",0]]', JSON.stringify(anchor.p));
check("anchor carries no text", !JSON.stringify(anchor).includes("Trois"));
check("generated ids rejected", !A.T.stableId(":r3:") && !A.T.stableId("ember1234") && !A.T.stableId("a1b2c3d4e5f6") && A.T.stableId("content"));

const B = page(`<div class="cookie-banner"><p>Cookies !</p></div>` + ARTICLE);
const r = B.T.resolve(anchor);
check("resolves to same button on other layout", r?.el === B.d.querySelector("li:nth-child(3) button") && r.exact);

const C = page(ARTICLE.replace("<button>Trois</button>", "<button>Quatre</button>"));
const rc = C.T.resolve(anchor);
check("different content → approximate", rc && rc.exact === false);

const D = page(ARTICLE.replace(/<ul>.*<\/ul>/, ""));
check("missing element → null (falls back to page coords)", D.T.resolve(anchor) === null);

// selection → quote → found at the right occurrence on the other page
const p2 = A.d.querySelectorAll("main p")[1].firstChild;
const sel = A.w.getSelection();
const range = A.d.createRange();
range.setStart(p2, 3);
range.setEnd(p2, 3 + "capitale de la France".length);
sel.removeAllRanges();
sel.addRange(range);
const q = A.T.currentQuote();
check("quote text", q?.exact === "capitale de la France", JSON.stringify(q));
const found = B.T.findQuote(q);
check("quote found in 2nd paragraph (prefix/suffix disambiguate)", found && found.startContainer === B.d.querySelectorAll("main p")[1].firstChild && found.startOffset === 3,
  found && found.startContainer.data);
check("quote absent → null", C.T.findQuote({ exact: "texte introuvable", prefix: "", suffix: "" }) === null);

// selection inside a field is never sent
const ta = page(`<textarea>mot de passe 1234</textarea>`);
const tr = ta.d.createRange();
tr.selectNodeContents(ta.d.querySelector("textarea"));
ta.w.getSelection().addRange(tr);
check("selection in textarea ignored", ta.T.currentQuote() === null);

// pointer events → messages, only when someone else is on the page
const P = page(ARTICLE);
const h1 = P.d.querySelector("h1");
h1.dispatchEvent(Object.assign(new P.w.MouseEvent("pointermove", { bubbles: true, clientX: 5, clientY: 5, }), { pointerType: "mouse" }));
check("no cursor sent when alone", !P.sent.some((m) => m.t === "cur"));
P.recv({ t: "config", config: { showCursors: false, shareCursor: true, shareSelection: true } });
P.recv({ t: "peers", list: [{ id: "x", name: "Bob", color: "#0090ff" }] });
h1.dispatchEvent(Object.assign(new P.w.MouseEvent("pointermove", { bubbles: true, clientX: 5, clientY: 5, }), { pointerType: "mouse" }));
const cur = P.sent.find((m) => m.t === "cur");
check("cursor sent with anchor on h1", cur && JSON.stringify(cur.a.p) === '[["h1",0]]' && cur.a.r === "content", JSON.stringify(cur));
h1.dispatchEvent(Object.assign(new P.w.MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5, button: 0 }), { pointerType: "mouse" }));
check("click sent", P.sent.some((m) => m.t === "click"));
check("url reported", P.sent[0]?.t === "url" && P.sent[0].url === "https://example.org/a");

// --- drawings ---
const K = page(ARTICLE);
K.recv({ t: "config", config: { showCursors: true, shareCursor: true, shareSelection: true, color: "#e5484d" } });
K.recv({ t: "mine", list: [{ id: "m1", a: anchor, pts: [[0, 0], [4, 4]] }] });
check("own saved drawing rendered", K.T.mine.size === 1 && K.T.getInk().querySelectorAll("path").length === 1 && K.T.getInk().querySelector("path").getAttribute("d") === "M0 0 L4 4");
K.recv({ t: "peers", list: [{ id: "bob", name: "Bob", color: "#0090ff", ink: true }] });
K.recv({ t: "draw", id: "bob", s: { id: "b1", a: anchor, pts: [[0, 0]], done: false } });
K.recv({ t: "draw", id: "bob", s: { id: "b1", pts: [[2, 3]], done: true } });
const bobStroke = K.T.getPeers().get("bob").strokes.get("b1");
check("peer stroke built from start + continuation", bobStroke?.pts.length === 2 && bobStroke.path.getAttribute("stroke") === "#0090ff");
K.recv({ t: "draw", id: "bob", s: { id: "zz", pts: [[1, 1]], done: true } });
check("continuation without a start is ignored", !K.T.getPeers().get("bob").strokes.has("zz"));
K.recv({ t: "peers", list: [{ id: "bob", name: "Bob", color: "#0090ff", ink: false }] });
await new Promise((r) => setTimeout(r, 60));
check("hidden person: stroke not displayed", bobStroke.g.getAttribute("display") === "none");
K.recv({ t: "peers", list: [{ id: "bob", name: "Bob", color: "#0090ff", ink: true }] });
await new Promise((r) => setTimeout(r, 60));
check("shown again", bobStroke.g.getAttribute("display") === null);
K.recv({ t: "undraw", id: "bob", sid: "b1" });
check("undo from peer removes the stroke", !K.T.getPeers().get("bob").strokes.size && !bobStroke.g.isConnected);
K.recv({ t: "drawings", id: "bob", list: [{ id: "b2", a: anchor, pts: [[0, 0], [1, 1]] }, { id: "b3", a: anchor, pts: [[0, 0]] }] });
check("all drawings of a peer at once", K.T.getPeers().get("bob").strokes.size === 2);
K.recv({ t: "peers", list: [] });
{
  await new Promise((r) => setTimeout(r, 100));
  const before = K.w.rafCount;
  await new Promise((r) => setTimeout(r, 300));
  check("idle page with drawings: no continuous redraw loop", K.w.rafCount === before, `${before} -> ${K.w.rafCount}`);
  K.w.dispatchEvent(new K.w.Event("scroll"));
  await new Promise((r) => setTimeout(r, 50));
  check("scrolling triggers one redraw", K.w.rafCount === before + 1, `${before} -> ${K.w.rafCount}`);
}
check("peer leaves: their drawings go", K.T.getInk().querySelectorAll("path").length === 1);

// drawing ourselves
K.sent.length = 0;
K.recv({ t: "drawMode", on: true, hint: "Mode dessin" });
const cap = K.T.getCapture();
check("draw mode shows the capture surface", cap.style.getPropertyValue("display") === "block");
const ev = (type, x, y) => cap.dispatchEvent(Object.assign(new K.w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }), { pointerId: 1 }));
ev("pointerdown", 10, 10);
ev("pointermove", 20, 15);
ev("pointermove", 21, 15); // too close: skipped
ev("pointermove", 40, 30);
ev("pointerup", 40, 30);
const drawMsgs = K.sent.filter((m) => m.t === "draw");
check("stroke start sent with anchor", drawMsgs[0]?.s.a && JSON.stringify(drawMsgs[0].s.pts) === "[[0,0]]");
check("stroke end sent with the new points", drawMsgs.at(-1)?.s.done === true && JSON.stringify(drawMsgs.slice(1).flatMap((m) => m.s.pts)) === "[[20,15],[40,30]]", JSON.stringify(drawMsgs)); // jsdom: no layout, origin at 0,0
check("no cursor sent while drawing", !K.sent.some((m) => m.t === "cur"));
K.w.dispatchEvent(new K.w.KeyboardEvent("keydown", { key: "z", ctrlKey: true }));
check("Ctrl+Z undoes our last stroke", K.sent.at(-1)?.t === "undraw" && K.T.mine.size === 1);
K.w.dispatchEvent(new K.w.KeyboardEvent("keydown", { key: "Escape" }));
check("Esc leaves draw mode and tells the engine", K.sent.at(-1)?.t === "drawMode" && K.sent.at(-1).on === false && cap.style.getPropertyValue("display") === "none");
K.recv({ t: "clearMine" });
check("clear mine", K.T.mine.size === 0);

console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL PASS");
setTimeout(() => process.exit(fails ? 1 : 0), 50);
})();
