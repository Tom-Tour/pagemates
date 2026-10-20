// Engine tests: several Pagemates engines in separate realms, with a fake PeerJS network
// and fake Nostr relays (real signatures and real proof of work, at a lower difficulty).
// Run: node tests/engine.test.mjs
import vm from "node:vm";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

const DIR = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const src = (f) => fs.readFileSync(DIR + f, "utf8");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fake PeerJS ---
const net = new Map();
class FakeConn extends EventEmitter {
  constructor(peer) { super(); this.peer = peer; this.open = false; }
  send(msg) { if (!this.open) throw new Error("closed"); const c = (this.other.parse ?? JSON.parse)(JSON.stringify(msg)); setTimeout(() => this.other.open && this.other.emit("data", c)); }
  close() { if (!this.open && !this.other.open) return; this.open = this.other.open = false; setTimeout(() => { this.emit("close"); this.other.emit("close"); }); }
}
class FakePeer extends EventEmitter {
  constructor() { super(); this.id = randomUUID(); this.destroyed = false; net.set(this.id, this); setTimeout(() => this.emit("open", this.id), 5); }
  connect(id, opts = {}) {
    const remote = net.get(id);
    const a = new FakeConn(id);
    const b = new FakeConn(this.id);
    a.other = b; b.other = a;
    a.parse = this.parse; b.parse = remote?.parse;
    a.metadata = b.metadata = opts.metadata;
    setTimeout(() => {
      if (!remote) return this.emit("error", { type: "peer-unavailable" });
      remote.emit("connection", b);
      a.open = b.open = true;
      a.emit("open"); b.emit("open");
    }, 5);
    return a;
  }
  destroy() { this.destroyed = true; net.delete(this.id); }
  reconnect() {}
}

// --- fake Worker running pow-worker.js in its own realm ---
class FakeWorker {
  constructor(file) {
    const w = vm.createContext({ TextEncoder, Uint8Array, Uint32Array, Int32Array, Math, setTimeout, console });
    const base = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
    w.importScripts = (f) => vm.runInContext(src(base + f), w);
    w.postMessage = (data) => setTimeout(() => this.onmessage?.({ data: JSON.parse(JSON.stringify(data)) }));
    vm.runInContext("var self = this;", w);
    vm.runInContext(src(file), w);
    this.w = w;
    FakeWorker.count++;
  }
  postMessage(data) { setTimeout(() => this.w.onmessage({ data })); }
  terminate() {}
}
FakeWorker.count = 0;

// --- fake Nostr relays ---
const bus = { events: [], subs: new Set() };
class FakePool {
  publish(_r, ev) {
    bus.events.push(ev);
    for (const s of bus.subs) if (match(s.filter, ev)) setTimeout(() => s.onevent(ev));
    return [Promise.resolve("ok")];
  }
  subscribeMany(_r, [filter], { onevent, oneose }) {
    const sub = { filter, onevent };
    bus.subs.add(sub);
    for (const ev of bus.events) if (match(filter, ev)) setTimeout(() => onevent(ev));
    setTimeout(() => oneose?.(), 2);
    return { close() { bus.subs.delete(sub); } };
  }
}
const match = (f, ev) => f.kinds.includes(ev.kind) && ev.tags.some((t) => t[0] === "t" && f["#t"].includes(t[1]));

// --- fake WebExtension APIs ---
let INSTANCE_SIZE = 20;
function makeEngine(label, storedSettings) {
  const store = { settings: storedSettings };
  const listeners = { connect: [], activated: [] };
  const badges = {};
  const badgeColors = {};
  const notes = [];
  const ev = (arr) => ({ addListener: (f) => arr.push(f) });
  const browser = {
    runtime: { onConnect: ev(listeners.connect), onInstalled: ev([]) },
    storage: { local: { get: async () => ({ ...store }), set: async (o) => Object.assign(store, o) } },
    tabs: { query: async () => [], onActivated: ev(listeners.activated), onAttached: ev([]), onRemoved: ev([]), executeScript: async () => {} },
    windows: { onRemoved: ev([]) },
    browserAction: { onClicked: ev([]), setBadgeBackgroundColor: async ({ tabId, color }) => { if (tabId) badgeColors[tabId] = color; }, setBadgeText: async ({ tabId, text }) => { badges[tabId] = text; } },
    notifications: { create: async (id, opts) => { notes.push(opts); } },
    sidebarAction: { toggle() {} },
  };
  const ctx = vm.createContext({
    browser, Worker: FakeWorker, console, setTimeout, clearTimeout, setInterval, clearInterval,
    crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, WebSocket: class {}, URL, URLSearchParams, navigator: { language: "fr-FR" },
  });
  const parse = vm.runInContext("JSON.parse", ctx);
  ctx.Peer = class extends FakePeer { constructor() { super(); this.parse = parse; } };
  vm.runInContext(src("vendor/nostr.bundle.js"), ctx);
  ctx.NostrTools = { ...ctx.NostrTools, SimplePool: FakePool };
  for (const f of ["common/i18n-core.js", "i18n.js", "common/net.js", "common/pow.js", "rooms.js", "background.js"]) {
    const code = src(f).replace("const INSTANCE_SIZE = 20", "const INSTANCE_SIZE = " + INSTANCE_SIZE).replace("BITS: 7,", "BITS: 2,");
    vm.runInContext(code, ctx, { filename: f });
  }

  function connect(name, tab) {
    const msgHandlers = [];
    const discHandlers = [];
    const inbox = [];
    const port = {
      name,
      sender: tab ? { tab } : {},
      onMessage: ev(msgHandlers),
      onDisconnect: ev(discHandlers),
      postMessage: (m) => inbox.push(JSON.parse(JSON.stringify(m))),
    };
    for (const l of listeners.connect) l(port);
    return {
      inbox,
      send: (m) => msgHandlers.forEach((h) => h(m)),
      disconnect: () => discHandlers.forEach((h) => h()),
      last: (t) => [...inbox].reverse().find((m) => m.t === t),
    };
  }
  return {
    label, ctx, badges, badgeColors, notes, store,
    page(tabId, url, windowId = 1) {
      const p = connect("page", { id: tabId, windowId, incognito: false });
      setTimeout(() => p.send({ t: "url", url }), 1);
      return p;
    },
    sidebar(windowId = 1) {
      const p = connect("sidebar");
      p.send({ cmd: "hello", args: [windowId] });
      let req = 0;
      p.ask = async (cmd, ...args) => {
        const id = ++req;
        p.send({ cmd, args, req: id });
        await wait(100);
        return p.inbox.find((m) => m.t === "reply" && m.req === id)?.error;
      };
      return p;
    },
    activate(windowId, tabId) { listeners.activated.forEach((l) => l({ windowId, tabId })); },
    eval: (code) => vm.runInContext(code, ctx),
  };
}

// --- scenario ---
let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
}

const base = { sites: { "fr.wikipedia.org": true }, sendRate: 20, recvRate: 1 }; // old settings, must be ignored
const A = makeEngine("A", { ...base, name: "Alice", color: "#e5484d" });
const B = makeEngine("B", { ...base, name: "Bob", color: "#0090ff" });
const mined = async (...E) => { while (!E.every((e) => e.eval("identity.pow") != null)) await wait(50); };
await mined(A, B); // preuve de travail des deux identités

const a1 = A.page(1, "https://fr.wikipedia.org/wiki/Paris?utm_source=twitter#Histoire");
const b1 = B.page(11, "https://www.fr.wikipedia.org/wiki/Paris/");
const b2 = B.page(12, "https://fr.wikipedia.org/wiki/Lyon");
A.activate(1, 1); B.activate(1, 11);
const sa = A.sidebar(1);
const sb = B.sidebar(1);
await wait(300);

const pubA = A.eval("identity.pubkey");
check("identity mined and stored", Number.isInteger(A.store.pow?.nonce) && A.store.pow.pubkey === pubA);
const pubB = B.eval("identity.pubkey");
const pageRoomA = () => A.eval("[...rooms.values()].find((r) => r.kind === 'page')");
check("A: one page room + one site room", A.eval("rooms.size") === 2 && A.eval("sitePeers.size") === 1);
check("B: 2 page rooms + 1 site room, one PeerJS", B.eval("rooms.size") === 3 && B.eval("sitePeers.size") === 1);
check("A sees B on Paris page", JSON.stringify(a1.last("peers")?.list.map((p) => p.name)) === '["Bob"]', JSON.stringify(a1.last("peers")));
check("B Paris tab sees A", b1.last("peers")?.list[0]?.id === pubA);
check("B Lyon tab sees nobody", (b2.last("peers")?.list ?? []).length === 0, JSON.stringify(b2.last("peers")));
check("badge counts 1 on A's tab", A.badges[1] === "1");
check("presence never contains the site in clear", !JSON.stringify(bus.events).includes("wikipedia"));
check("presence carries the instance", bus.events.some((e) => JSON.parse(e.content).inst === 1));

// cursor routed only to the same page
a1.send({ t: "cur", a: { r: "", p: [["div", 0], ["p", 2]], x: 0.3, y: 0.6, h: 123, fx: 0.1, fy: 0.2 } });
await wait(30);
check("cursor reaches B on Paris", b1.last("cur")?.id === pubA && b1.last("cur")?.a.x === 0.3);
check("cursor not on Lyon tab", !b2.last("cur"));
a1.send({ t: "cur", a: { r: "", p: [["<script>", 0]], x: 0, y: 0 } });
await wait(30);
check("invalid anchor dropped", b1.inbox.filter((m) => m.t === "cur").length === 1);
b1.send({ t: "sel", q: { exact: "capitale de la France", prefix: "est la ", suffix: " et" } });
await wait(30);
check("selection reaches A", a1.last("sel")?.q.exact === "capitale de la France");

// chat rooms
check("page chat sent", (await sa.ask("chat", 1, "page", "salut la page")) === null);
const snapB = () => sb.last("snap").snap;
check("B sees page chat", snapB().page.chat.some((m) => m.text === "salut la page" && m.from === pubA), JSON.stringify(snapB().page));
check("page chat not in site chat", !snapB().site.chat.some((m) => m.text === "salut la page"));
await wait(1100);
await sa.ask("chat", 1, "site", "salut le site");
check("B sees site chat", snapB().site.chat.some((m) => m.text === "salut le site"));
check("site people list marks A as on the page", snapB().site.people.find((p) => p.id === pubA)?.here === true);
B.activate(1, 12); // Bob looks at the Lyon tab
await wait(80);
check("Lyon tab: own page chat, shared site chat", snapB().page.chat.every((m) => m.system) && snapB().site.chat.some((m) => m.text === "salut le site"));
check("Lyon tab: A on site but not here", snapB().site.people.find((p) => p.id === pubA)?.here === false && snapB().page.people.length === 0);
B.activate(1, 11);

// send rate limit (A: 2/s)
await wait(1100);
const r = [await sa.ask("chat", 1, "site", "1"), await sa.ask("chat", 1, "site", "2"), await sa.ask("chat", 1, "site", "3")];
check("A's 3rd message in a second refused", r[0] === null && r[1] === null && r[2] === "errTooFast", JSON.stringify(r));

// a normal client sending at its maximum is never filtered by the receiver
await wait(1100);
for (let k = 0; k < 4; k++) {
  await sb.ask("chat", 1, "site", "normal" + k + "a");
  await sb.ask("chat", 1, "site", "normal" + k + "b");
  await wait(1000);
}
const normal = sa.last("snap").snap.site.chat.filter((m) => m.text?.startsWith("normal")).length;
check("normal client at 2/s: all 8 messages received", normal === 8, `got ${normal}`);

// receive limit against a modified client (6 messages at once): only 3 kept
await wait(1100);
B.eval(`for (const r of rooms.values()) if (r.kind === "site") for (const m of r.members.values()) for (let i = 0; i < 6; i++) m.conn.send({ t: "chat", text: "flood" + i })`);
await wait(100);
const got = sa.last("snap").snap.site.chat.filter((m) => m.text?.startsWith("flood")).length;
check("A kept only 3 of the modified client's 6 messages", got === 3, `got ${got}`);
check("old anti-flood settings dropped", !("sendRate" in A.store.settings) && !("recvRate" in A.store.settings));
await wait(1100);

// sustained flood from a modified client (bypasses its own send limit)
B.eval(`globalThis.rawFlood = () => { for (const r of rooms.values()) if (r.kind === "site") for (const m of r.members.values()) for (let i = 0; i < 50; i++) m.conn.send({ t: "chat", text: "spam" }); }`);
B.eval("rawFlood()");
await wait(150);
check("flooder muted", sa.last("snap").snap.site.people.find((p) => p.id === pubB)?.muted === true, JSON.stringify(sa.last("snap").snap.site.people));
A.eval(`for (const r of rooms.values()) for (const m of r.members.values()) m.mutedUntil = 0`);

// DMs
await wait(1100);
check("DM sent", (await sa.ask("dm", pubB, "coucou en privé")) === null);
const thread = snapB().dms.find((d) => d.id === pubA);
check("B got the DM, unread", thread?.msgs[0]?.text === "coucou en privé" && thread.unread === 1, JSON.stringify(snapB().dms));
check("DM not in public chats", !snapB().site.chat.concat(snapB().page.chat).some((m) => m.text === "coucou en privé"));
check("B's badge shows the unread DM in red", B.badges[11] === "✉1" && B.badgeColors[11] === "#e5484d", B.badges[11]);
check("no notification while a sidebar is open", B.notes.length === 0);
sb.send({ cmd: "readDm", args: [pubA] });
await wait(80);
check("reading it restores the page count", B.badges[11] === "1" && B.badgeColors[11] === "#0090ff", B.badges[11]);
B.eval("globalThis.savedSidebars = [...sidebars]; sidebars.clear()");
await wait(1100);
await sa.ask("dm", pubB, "tu es là ?");
await wait(80);
const codeA = A.eval("identity.code");
check("notification when no sidebar is open, with name and code, without the text", B.notes.length === 1 && B.notes[0].message.includes("Alice · " + codeA) && !B.notes[0].message.includes("tu es là"), JSON.stringify(B.notes));
B.eval("for (const sbx of savedSidebars) sidebars.add(sbx)");
sb.send({ cmd: "readDm", args: [pubA] });
check("own code: 4 hex chars, stored with the proof", /^[0-9A-F]{4}$/.test(codeA) && A.store.pow.code === codeA);
check("others see the same code next to the name", snapB().page.people.find((p) => p.id === pubA)?.code === codeA && snapB().dms.find((d) => d.id === pubA)?.code === codeA);
check("sidebar gets my own code", sa.last("snap").snap.myCode === codeA);

// renaming propagates to cursors
await wait(1100);
sb.send({ cmd: "setSettings", args: [{ name: "Bobby", color: "#46a758" }] });
await wait(80);
check("rename reaches A's page", a1.last("peers")?.list[0]?.name === "Bobby" && a1.last("peers")?.list[0]?.color === "#46a758");

// forged handshake: signed by a valid key but aimed at another peer
const pr = pageRoomA();
const forger = new FakePeer();
await wait(20);
const conn = forger.connect(pr.sp.id, { metadata: { room: pr.key } });
await wait(20);
A.ctx.forgerId = forger.id;
const forged = A.eval(`NostrTools.finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [["from", forgerId], ["to", "someone-else"], ["room", "${pr.key}"], ["inst", "1"]], content: "" }, NostrTools.generateSecretKey())`);
conn.send({ t: "hello", ev: forged, name: "Mallory", color: "#000000" });
await wait(50);
check("forged hello rejected", !conn.open && pageRoomA().members.size === 1);

// valid signature and tags, but bad or borrowed proof of work
const scryptLib = (await import("module")).createRequire(import.meta.url)("../common/scrypt.js");
const enc = new TextEncoder();
const bitsOf = (pk, n) => { const h = scryptLib.syncScrypt(enc.encode(`pagemates-identity:${pk}:${n}`), enc.encode("pagemates-pow-v2"), 4096, 8, 1, 32); let b = 0; for (const x of h) { if (x === 0) { b += 8; continue; } return b + Math.clz32(x) - 24; } return b; };
async function tryHello(powValue, label) {
  const f = new FakePeer();
  await wait(20);
  const c = f.connect(pageRoomA().sp.id, { metadata: { room: pageRoomA().key } });
  await wait(20);
  A.ctx.fid = f.id;
  A.ctx.fsk = A.eval("NostrTools.generateSecretKey()");
  const fpk = A.eval("NostrTools.getPublicKey(fsk)");
  let nonce = powValue;
  if (powValue === "weak") { nonce = 0; while (bitsOf(fpk, nonce) >= 2) nonce++; }
  if (powValue === "borrowed") nonce = A.store.pow.nonce; // someone else's proof
  A.ctx.fnonce = String(nonce);
  const ev = A.eval(`NostrTools.finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [["from", fid], ["to", "${pageRoomA().sp.id}"], ["room", "${pageRoomA().key}"], ["inst", "1"], ["pow", fnonce]], content: "" }, fsk)`);
  if (powValue === "borrowed" && bitsOf(fpk, nonce) >= 2) return check(label + " (skipped: lucky nonce)", true);
  c.send({ t: "hello", ev, name: "Mallory", color: "#000000" });
  await wait(400);
  check(label, !c.open && pageRoomA().members.size === 1);
}
await tryHello("abc", "hello with non-numeric proof rejected");
await tryHello("weak", "hello with too weak proof rejected");
await tryHello("borrowed", "hello reusing another identity's proof rejected");

// B leaves the Paris page (navigates)
b1.send({ t: "url", url: "https://fr.wikipedia.org/wiki/Marseille" });
await wait(150);
check("A's Paris tab sees nobody after B navigates", a1.last("peers")?.list.length === 0);
check("A gets 'left the page'", sa.last("snap").snap.page.chat.some((m) => m.key === "sysLeftPage"));
b1.send({ t: "url", url: "https://fr.wikipedia.org/wiki/Paris" });
await wait(150);
check("B back on Paris: A sees B again", a1.last("peers")?.list.length === 1);

// --- drawings ---
const anchorPara = { r: "", p: [["main", 0], ["p", 1]], x: 0.2, y: 0.5, h: 7, fx: 0.3, fy: 0.4 };
check("draw mode needs no error on an open page room", (await sa.ask("drawMode", 1, true)) === null);
check("draw mode reaches the page with its hint", a1.last("drawMode")?.on === true && a1.last("drawMode").hint.includes("Échap"));
check("sidebar knows draw mode is on", sa.last("snap").snap.ctx.drawMode === true);
a1.send({ t: "draw", s: { id: "s1", a: anchorPara, pts: [[0, 0]], done: false } });
a1.send({ t: "draw", s: { id: "s1", pts: [[5, 5], [10, 12]], done: true } });
await wait(60);
const draws = b1.inbox.filter((m) => m.t === "draw");
check("stroke start reaches B with anchor", draws[0]?.id === pubA && draws[0].s.a?.p.length === 2 && draws[0].s.id === "s1");
check("stroke continuation reaches B", draws[1]?.s.pts.length === 2 && !draws[1].s.a && draws[1].s.done === true);
a1.send({ t: "draw", s: { id: "bad", a: anchorPara, pts: [[0.5, 1e9]], done: true } });
a1.send({ t: "draw", s: { id: "BAD ID!", a: anchorPara, pts: [[0, 0]], done: true } });
await wait(60);
check("malformed strokes not relayed", b1.inbox.filter((m) => m.t === "draw").length === 2);
await wait(1200);
const stored = Object.values(A.store.ink ?? {})[0];
check("own stroke stored (3 points)", stored?.length === 1 && stored[0].pts.length === 3, JSON.stringify(A.store.ink));
check("sidebar counts my drawings", sa.last("snap").snap.ctx.myInk === 1);
a1.send({ t: "drawMode", on: false });
await wait(80);
check("Esc in the page turns draw mode off", sa.last("snap").snap.ctx.drawMode === false);

// someone arriving later gets the drawings at once
const C = makeEngine("C", { ...base, name: "Chloé" });
await mined(C);
const c1 = C.page(1, "https://fr.wikipedia.org/wiki/Paris");
for (let i = 0; i < 60 && !c1.inbox.some((m) => m.t === "drawings"); i++) await wait(50);
const got1 = c1.inbox.find((m) => m.t === "drawings" && m.id === pubA);
check("newcomer receives existing drawings", got1?.list.length === 1 && got1.list[0].pts.length === 3, JSON.stringify(c1.inbox.filter((m) => m.t === "drawings")));

// hide one person's drawings
sb.send({ cmd: "toggleInk", args: [pubA] });
await wait(80);
check("hide A's drawings: page told ink=false", b1.last("peers")?.list.find((p) => p.id === pubA)?.ink === false);
check("hidden choice remembered", B.store.settings.hiddenInk?.[pubA] === true && snapB().page.people.find((p) => p.id === pubA)?.inkHidden === true);
sb.send({ cmd: "toggleInk", args: [pubA] });
await wait(80);
check("show again", b1.last("peers")?.list.find((p) => p.id === pubA)?.ink === true && !B.store.settings.hiddenInk?.[pubA]);

// undo and clear
a1.send({ t: "draw", s: { id: "s2", a: anchorPara, pts: [[0, 0], [3, 3]], done: true } });
await wait(60);
a1.send({ t: "undraw", id: "s2" });
await wait(60);
check("undo reaches others", b1.last("undraw")?.sid === "s2" && b1.last("undraw").id === pubA);
sa.send({ cmd: "clearInk", args: [1] });
await wait(1200);
check("clear: others told to drop all, page told to clear mine", b1.last("undraw")?.all === true && !!a1.last("clearMine"));
check("clear: nothing stored anymore", !Object.keys(A.store.ink ?? {}).length);

// my drawings come back when I return
a1.send({ t: "draw", s: { id: "s3", a: anchorPara, pts: [[0, 0], [8, 8]], done: true } });
await wait(60);
const a1bis = A.page(3, "https://fr.wikipedia.org/wiki/Paris");
await wait(200);
check("own drawings sent back to a new tab on the page", a1bis.last("mine")?.list.some((s) => s.id === "s3"));
a1bis.disconnect();
C.eval("for (const k of [...rooms.keys()]) endRoom(k)");
await wait(100);

// view "page only": site room is left
sb.send({ cmd: "setSettings", args: [{ view: "page" }] });
await wait(80);
check("view=page leaves the site room", B.eval("[...rooms.values()].every((r) => r.kind === 'page')") && snapB().site === null);
sb.send({ cmd: "setSettings", args: [{ view: "both" }] });
await wait(150);

// block
sa.send({ cmd: "block", args: [pubB] });
await wait(80);
check("block disconnects", pageRoomA().members.size === 0 && a1.last("peers")?.list.length === 0);
check("block persisted, with name and code", !!A.store.settings.blocked[pubB] && A.store.settings.blocked[pubB].endsWith(" · " + B.eval("identity.code")), A.store.settings.blocked[pubB]);
await wait(80);
const after = sa.last("snap").snap;
check("blocked person's past messages hidden", !after.site.chat.concat(after.page.chat).some((m) => m.from === pubB) && !after.dms.some((d) => d.id === pubB));
for (const E of [A, B]) E.eval(`for (const r of rooms.values()) { r.sub.close(); subscribePresence(r); }`);
await wait(150);
check("blocked person can't come back", pageRoomA().members.size === 0);
sa.send({ cmd: "unblock", args: [pubB] });

// leave site
await wait(50);
sa.send({ cmd: "setSite", args: ["fr.wikipedia.org", false] });
await wait(80);
check("A left: no rooms, PeerJS released", A.eval("rooms.size") === 0 && A.eval("sitePeers.size") === 0);
check("leave publishes a 'left' presence", bus.events.some((e) => e.content.includes('"left":true')));

// disconnect switch
sb.send({ cmd: "setSettings", args: [{ connected: false }] });
await wait(50);
check("disconnect closes all B rooms", B.eval("rooms.size") === 0);

// --- instances (size 2 for the test) ---
INSTANCE_SIZE = 2;
const ex = { sites: { "example.com": true } };
const E1 = makeEngine("E1", { ...ex, name: "Un" });
const E2 = makeEngine("E2", { ...ex, name: "Deux" });
const E3 = makeEngine("E3", { ...ex, name: "Trois" });
await mined(E1, E2, E3);
const URL_ = "https://example.com/article";
const e1 = E1.page(1, URL_);
await wait(100);
const e2 = E2.page(1, URL_);
await wait(100);
const e3 = E3.page(1, URL_);
E3.activate(1, 1);
const s3 = E3.sidebar(1);
await wait(150);
const instOf = (E) => E.eval("[...rooms.values()].find((r) => r.kind === 'page').inst");
check("first two in instance #1, third in #2", instOf(E1) === 1 && instOf(E2) === 1 && instOf(E3) === 2, `${instOf(E1)} ${instOf(E2)} ${instOf(E3)}`);
check("#1 members see each other only", e1.last("peers")?.list.length === 1 && e2.last("peers")?.list.length === 1 && (e3.last("peers")?.list ?? []).length === 0);
const inst3 = s3.last("snap").snap.page.instances;
check("sidebar lists instances with counts", JSON.stringify(inst3) === '[{"n":1,"count":2},{"n":2,"count":1}]', JSON.stringify(inst3));
check("move to #1 by hand (soft limit)", (await s3.ask("setInstance", 1, "page", 1)) === null);
await wait(150);
check("third now sees both in #1", instOf(E3) === 1 && e3.last("peers")?.list.length === 2, JSON.stringify(e3.last("peers")));
check("new empty instance", (await s3.ask("setInstance", 1, "page", "new")) === null && instOf(E3) === 2);
await wait(150);
check("alone again in the new instance", e3.last("peers")?.list.length === 0 && e1.last("peers")?.list.length === 1);

// --- page address: ignored params, user choices, sections ---
INSTANCE_SIZE = 20;
const yt = { sites: { "youtube.com": true, "forum.example": true } };
const Y1 = makeEngine("Y1", { ...yt, name: "Yan" });
const Y2 = makeEngine("Y2", { ...yt, name: "Zoé" });
await mined(Y1, Y2);
const y1 = Y1.page(1, "https://www.youtube.com/watch?v=ar-6Bdo3U4c");
const y2 = Y2.page(1, "https://www.youtube.com/watch?v=ar-6Bdo3U4c&list=RDar-6Bdo3U4c&start_radio=1&t=29530s");
Y1.activate(1, 1); Y2.activate(1, 1);
const sy1 = Y1.sidebar(1), sy2 = Y2.sidebar(1);
await wait(300);
check("same video, with or without playlist/time: same room", y1.last("peers")?.list.length === 1 && y2.last("peers")?.list.length === 1);
const parts2 = () => sy2.last("snap").snap.ctx.parts;
check("address parts listed, list/t/start_radio off by default, v on",
  JSON.stringify(parts2().params.map((p) => p.name + ":" + p.on)) === '["v:true","list:false","start_radio:false","t:false"]' && !parts2().custom,
  JSON.stringify(parts2()));
sy2.send({ cmd: "setPageParam", args: ["youtube.com", "list", true] });
await wait(300);
check("including 'list' by hand: own room", y2.last("peers")?.list.length === 0 && parts2().params.find((p) => p.name === "list").on && parts2().custom);
check("choice remembered for the site", Y2.store.settings.pageRules["youtube.com"]?.params.list === true);
check("leaving the old page room is immediate", y1.last("peers")?.list.length === 0);
sy2.send({ cmd: "resetPage", args: ["youtube.com"] });
await wait(300);
check("reset: back together", y2.last("peers")?.list.length === 1 && !parts2().custom && !Y2.store.settings.pageRules["youtube.com"]);
sy2.send({ cmd: "setPageParam", args: ["youtube.com", "v", false] });
await wait(300);
check("excluding 'v': every video in one room (alone here)", y2.last("peers")?.list.length === 0);
sy2.send({ cmd: "setPageParam", args: ["youtube.com", "v", true] });
await wait(300);
check("v back on: rule emptied, together again", !Y2.store.settings.pageRules["youtube.com"] && y2.last("peers")?.list.length === 1);

// sections: cut the path after /r/france
const f1 = Y1.page(2, "https://forum.example/r/france/comments/abc/titre");
const f2 = Y2.page(2, "https://forum.example/r/france/comments/def/autre-titre");
Y1.activate(1, 2); Y2.activate(1, 2);
await wait(300);
check("two different posts: different rooms", f1.last("peers")?.list.length === 0 && f2.last("peers")?.list.length === 0);
sy1.send({ cmd: "setPageDepth", args: ["forum.example", 2] });
sy2.send({ cmd: "setPageDepth", args: ["forum.example", 2] });
await wait(300);
check("both cut at /r/france: same section room", f1.last("peers")?.list.length === 1 && f2.last("peers")?.list.length === 1);
check("parts show depth 2", sy2.last("snap").snap.ctx.parts.depth === 2 && sy2.last("snap").snap.ctx.parts.segments.length === 5);
sy2.send({ cmd: "setPageDepth", args: ["forum.example", null] });
await wait(300);
check("restore full address: back to own post room", f2.last("peers")?.list.length === 0 && sy2.last("snap").snap.ctx.parts.depth === null);

// heartbeat: a connection that went silent (unreported WebRTC loss) is dropped
const ytKey = Y1.eval(`[...rooms.values()].find((r) => r.kind === "page" && r.members.size).key`);
const ytMember = (E) => `rooms.get(${JSON.stringify(ytKey)}).members.values().next().value`;
Y1.eval(`${ytMember(Y1)}.heard = Date.now() - 31000; heartbeat();`);
await wait(50);
check("silent member who never pinged (older version): kept", Y1.eval(`rooms.get(${JSON.stringify(ytKey)}).members.size`) === 1);
Y2.eval(`heartbeat()`);
await wait(50);
check("ping received: member marked as beating", Y1.eval(`${ytMember(Y1)}.beats`) === true);
Y1.eval(`${ytMember(Y1)}.heard = Date.now() - 31000; heartbeat();`);
await wait(50);
check("silent for 30 s after pinging: dropped as a normal leave", Y1.eval(`rooms.get(${JSON.stringify(ytKey)}).members.size`) === 0 && y1.last("peers")?.list.length === 0);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
