// Sidebar tests in jsdom: where bar, channels, person card, blocking, drawing tools.
// Run: node tests/sidebar.test.cjs
const fs = require("fs");
const { JSDOM } = require("jsdom");
const D = require("path").join(__dirname, "..") + "/";
const html = fs.readFileSync(D + "sidebar.html", "utf8").replace(/<script src[^>]*><\/script>/g, "");
const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
const w = dom.window;
const sent = []; const listeners = [];
w.browser = {
  runtime: { connect: () => ({ postMessage: (m) => sent.push(m), onMessage: { addListener: (f) => listeners.push(f) } }), getManifest: () => ({ version: "x" }) },
  windows: { getCurrent: async () => ({ id: 1 }) },
};
w.eval(["common/i18n-core.js", "i18n.js", "common/ui.js", "sidebar.js"].map((f) => fs.readFileSync(D + f, "utf8")).join(String.fromCharCode(10)));
const room = (inst) => ({ status: "open", inst, instances: [{ n: 1, count: 20 }, { n: 2, count: 3 }], people: [{ id: "b", name: "Bob", color: "#0090ff", code: "7F3A", here: true, muted: false }], chat: [{ id: 1, at: Date.now(), from: "b", name: "Bob", color: "#0090ff", text: "salut" }] });
const snap = { settings: { lang: "fr", view: "both", connected: true, name: "Moi", color: "#e5484d", sites: {}, blocked: {}, hiddenInk: {}, showCursors: true, shareCursor: true, shareSelection: true, autoJoin: false, }, palette: ["#e5484d"], me: "me", instanceSize: 20, sendRate: 2, ctx: { site: "youtube.com", enabled: true, incognito: false, drawMode: false, myInk: 2, parts: { segments: ["watch"], depth: null, custom: false, params: [{ name: "v", value: "ar-6Bdo3U4c", on: true }, { name: "list", value: "RDar-6Bdo3U4c", on: false }] } }, page: room(2), site: room(1), dms: [], log: [] };
let fails = 0; const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  " + x}`); if (!c) fails++; };
setTimeout(() => {
  listeners.forEach((f) => f({ t: "snap", snap }));
  const $ = (q) => w.document.querySelector(q);
  check("where bar visible on page tab", !$("#where").hidden);
  const tokens = [...w.document.querySelectorAll("#where-path .token")];
  check("address tokens", tokens.map((b) => b.textContent).join(" ") === "/watch ?v=ar-6Bdo3U4c &list=RDar-6Bdo3U4c" && $("#where-path strong").textContent === "youtube.com", tokens.map((b) => b.textContent).join(" "));
  check("ignored param struck", tokens[2].classList.contains("off") && !tokens[1].classList.contains("off"));
  tokens[2].click();
  check("click on param includes it", sent.some((m) => m.cmd === "setPageParam" && JSON.stringify(m.args) === '["youtube.com","list",true]'));
  check("channel button", $("#channel-btn").textContent === "Canal #2 · 3/20 ▾", $("#channel-btn").textContent);
  check("menu closed by default", $("#channel-menu").hidden);
  $("#channel-btn").click();
  check("click opens channel list", !$("#channel-menu").hidden && $("#channel-list").textContent.includes("#1 · 20/20"));
  const input = $("#channel-go input");
  check("number input translated", input.placeholder === "N° de canal" && $("#channel-go button").textContent === "Aller");
  input.focus(); input.value = "42";
  listeners.forEach((f) => f({ t: "snap", snap })); // refresh while typing
  check("menu and typing survive a refresh", !$("#channel-menu").hidden && w.document.activeElement === input && input.value === "42");
  $("#channel-go").dispatchEvent(new w.Event("submit", { cancelable: true }));
  const cmd = sent.find((m) => m.cmd === "setInstance");
  check("submit sends setInstance(42) and closes", cmd && JSON.stringify(cmd.args) === '[1,"page",42]' && $("#channel-menu").hidden, JSON.stringify(cmd));
  $("#channel-btn").click();
  [...$("#channel-list").querySelectorAll("button")].find((b) => b.textContent.startsWith("#1")).click();
  check("pick a channel from the list", sent.some((m) => m.cmd === "setInstance" && m.args[2] === 1) && $("#channel-menu").hidden);
  check("no + button anymore", ![...w.document.querySelectorAll("#where button")].some((b) => b.textContent === "+"));
  $("#tabs [data-tab=site]").click();
  check("site tab shows only the site", $("#where-path").textContent === "youtube.com" && $("#channel-btn").textContent === "Canal #1 · 20/20 ▾", $("#where-path").textContent);
  $("#tabs [data-tab=page]").click();
  check("no mining banner by default", w.document.querySelector("#mining").hidden);
  listeners.forEach((f) => f({ t: "snap", snap: { ...snap, mining: { percent: 25 } } }));
  check("mining banner shows 25 %", !w.document.querySelector("#mining").hidden && w.document.querySelector("#mining-title").textContent.includes("25 %"), w.document.querySelector("#mining-title").textContent);
  check("no failure notice while mining", w.document.querySelector("#identity-failed").hidden);
  listeners.forEach((f) => f({ t: "snap", snap: { ...snap, mining: null, identityFailed: true } }));
  const failed = w.document.querySelector("#identity-failed");
  check("failure notice shown instead of the mining banner", !failed.hidden && w.document.querySelector("#mining").hidden && failed.textContent.includes("Création de l'identité impossible"), failed.textContent);
  w.document.querySelector("#identity-retry").click();
  check("retry button sends retryIdentity", w.document.querySelector("#identity-retry").textContent === "Réessayer" && sent.some((m) => m.cmd === "retryIdentity"));
  listeners.forEach((f) => f({ t: "snap", snap: { ...snap, mining: null } }));
  check("failure notice gone once fixed", failed.hidden);
  check("chat rendered", w.document.querySelector("#chat").textContent.includes("salut"));
  // person card: blocking takes three deliberate steps
  const q = (sel) => w.document.querySelector(sel);
  const btn = (box, text) => [...w.document.querySelectorAll(box + " button")].find((b) => b.textContent.includes(text));
  check("no inline block button on names", !btn("#people", "⛔"));
  btn("#people", "Bob").click();
  check("code shown next to the name", btn("#people", "Bob").textContent.includes("7F3A"));
  check("click on a name opens the card", !q("#person").hidden && q("#person strong").textContent === "Bob" && q("#person .code").textContent === "7F3A");
  check("card actions", !!btn("#person", "Message privé") && !!btn("#person", "Masquer ses dessins") && !!btn("#person", "Bloquer…"));
  btn("#person", "Masquer ses dessins").click();
  check("hide drawings sends toggleInk", sent.some((m) => m.cmd === "toggleInk" && m.args[0] === "b"));
  btn("#person", "Bloquer…").click();
  check("block asks for confirmation with consequences", q("#person").textContent.includes("Bloquer Bob ?") && q("#person").textContent.includes("débloquer dans les réglages"));
  check("nothing blocked yet", !sent.some((m) => m.cmd === "block"));
  listeners.forEach((f) => f({ t: "snap", snap: { ...snap, mining: null } }));
  check("confirmation survives a refresh", q("#person").textContent.includes("Bloquer Bob ?"));
  btn("#person", "Annuler").click();
  check("cancel goes back to the card", !!btn("#person", "Bloquer…") && !sent.some((m) => m.cmd === "block"));
  btn("#person", "Bloquer…").click();
  btn("#person", "Bloquer Bob").click();
  check("third step blocks", sent.some((m) => m.cmd === "block" && m.args[0] === "b") && q("#person").hidden);
  // chat name opens the card too
  [...w.document.querySelectorAll("#chat .who")].find((e) => e.textContent === "Bob").click();
  check("name in chat opens the card", !q("#person").hidden);
  btn("#person", "✕").click();
  // drawing tools
  check("draw button", !!btn("#tools", "Dessiner") && !!btn("#tools", "Effacer mes dessins (2)"));
  btn("#tools", "Dessiner").click();
  check("draw button sends drawMode on", sent.some((m) => m.cmd === "drawMode" && m.args[1] === true));
  btn("#tools", "Effacer mes dessins").click();
  check("clear asks « Sûr ? » first", !!btn("#tools", "Sûr ?") && !sent.some((m) => m.cmd === "clearInk"));
  listeners.forEach((f) => f({ t: "snap", snap: { ...snap, mining: null } }));
  check("still armed after a refresh", !!btn("#tools", "Sûr ?"));
  btn("#tools", "Sûr ?").click();
  check("then clears", sent.some((m) => m.cmd === "clearInk"));
  // DM tab: card through ⋯
  const dmSnap = { ...snap, mining: null, dms: [{ id: "c", name: "Carla", color: "#46a758", online: true, unread: 0, msgs: [] }] };
  listeners.forEach((f) => f({ t: "snap", snap: dmSnap }));
  q("#tabs [data-tab=dm]").click();
  check("tab label", q("#tabs [data-tab=dm]").textContent.includes("Message privé"));
  btn("#dm-list", "⋯").click();
  check("⋯ in DM list opens Carla's card", !q("#person").hidden && q("#person strong").textContent === "Carla");
  // sound for new messages (common setting)
  let beeps = 0;
  w.beep = () => beeps++;
  const withMsg = (sound, id) => ({ ...snap, mining: null, settings: { ...snap.settings, chatSound: sound }, page: { ...snap.page, chat: [...snap.page.chat, { id, at: Date.now(), from: "b", name: "Bob", color: "#0090ff", text: "hop" + id }] } });
  listeners.forEach((f) => f({ t: "snap", snap: withMsg(false, 50) }));
  check("no sound when the setting is off", beeps === 0);
  listeners.forEach((f) => f({ t: "snap", snap: withMsg(true, 51) }));
  check("sound for a new message when on", beeps === 1);
  listeners.forEach((f) => f({ t: "snap", snap: withMsg(true, 51) }));
  check("no sound for the same message again", beeps === 1);
  // own messages: the nickname, highlighted; nickname offered until chosen
  q("#tabs [data-tab=page]").click();
  const mine = (nameSet) => ({ ...snap, mining: null, settings: { ...snap.settings, name: "Invité-4242", nameSet }, page: { ...snap.page, chat: [...snap.page.chat, { id: 60, at: Date.now(), from: "me", name: "Invité-4242", color: "#e5484d", text: "coucou" }] } });
  listeners.forEach((f) => f({ t: "snap", snap: mine(false) }));
  const myName = [...w.document.querySelectorAll("#chat .who.me")];
  check("own message shows the nickname", myName.length === 1 && myName[0].textContent === "Invité-4242", myName.map((e) => e.textContent).join());
  check("nickname offered before talking", !q("#name-ask").hidden && q("#ask-name").value === "Invité-4242" && q("#name-ask label").textContent === "Pseudo" && q("#name-ask").title.startsWith("Pseudo affiché"));
  q("#ask-name").value = "Tom";
  q("#name-ask").dispatchEvent(new w.Event("submit", { cancelable: true }));
  const named = sent.filter((m) => m.cmd === "setSettings").at(-1);
  check("choosing it saves the nickname", named && JSON.stringify(named.args) === '[{"name":"Tom"}]', JSON.stringify(named));
  listeners.forEach((f) => f({ t: "snap", snap: mine(true) }));
  check("no offer once chosen", q("#name-ask").hidden);
  console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
}, 50);
