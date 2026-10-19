// Barre latérale : affiche le salon de l'onglet actif de sa fenêtre. Tout le moteur tourne
// dans background.js ; on envoie des commandes par le port et on affiche l'état reçu.

const $ = (s) => document.querySelector(s);

const port = browser.runtime.connect({ name: "sidebar" });
let snap = null;
let tab = "page"; // "page" | "site" | "dm"
let dmWith = null; // pubkey de la conversation privée ouverte
let windowId = null;
let lastChat = "";

let reqSeq = 0;
const waiting = new Map();

function act(cmd, ...args) {
  port.postMessage({ cmd, args });
}

// Commande avec réponse (envoi de message : refusé si trop rapide, etc.)
function ask(cmd, ...args) {
  const req = ++reqSeq;
  port.postMessage({ cmd, args, req });
  return new Promise((resolve) => waiting.set(req, resolve));
}

let translated = false;
port.onMessage.addListener((msg) => {
  if (msg.t === "reply") {
    waiting.get(msg.req)?.(msg.error);
    waiting.delete(msg.req);
    return;
  }
  snap = msg.snap;
  if (setLang(snap.settings.lang) || !translated) {
    translated = true;
    applyI18n();
    lastChat = "";
  }
  render();
});

browser.windows.getCurrent().then((w) => {
  windowId = w.id;
  act("hello", windowId);
});

$("#version").textContent = browser.runtime.getManifest().version;

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) e.append(c);
  return e;
}

// --- Onglets ------------------------------------------------------------------------

for (const b of document.querySelectorAll("#tabs button")) {
  b.addEventListener("click", () => {
    tab = b.dataset.tab;
    showError(null);
    render();
    $("#text").focus();
  });
}

function openDm(id) {
  act("openDm", id);
  tab = "dm";
  dmWith = id;
  showError(null);
  render();
  $("#text").focus();
}

// Bouton à confirmer d'un second clic (les fenêtres de confirmation ne marchent pas ici)
function confirmButton(label, sure, onConfirm) {
  const b = el("button", { textContent: label, title: sure });
  let armed = null;
  b.addEventListener("click", () => {
    if (armed) return onConfirm();
    b.textContent = label + " ?";
    b.classList.add("danger");
    armed = setTimeout(() => {
      armed = null;
      b.textContent = label;
      b.classList.remove("danger");
    }, 3000);
  });
  return b;
}

// --- Affichage ------------------------------------------------------------------------

function render() {
  if (!snap) return;
  const { settings, ctx, people } = snap;

  // Salons affichés selon le réglage
  $("#tabs [data-tab=page]").hidden = settings.view === "site";
  $("#tabs [data-tab=site]").hidden = settings.view === "page";
  if ((tab === "page" && settings.view === "site") || (tab === "site" && settings.view === "page")) {
    tab = settings.view === "site" ? "site" : "page";
  }
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("on", b.dataset.tab === tab);

  // En-tête
  const inRoom = ctx?.enabled && !ctx.incognito;
  const status = inRoom ? ctx.status : "off";
  $("#dot").className = status;
  $("#site").textContent = ctx?.site ?? "Pagemates";
  const here = people.filter((p) => p.here).length;
  $("#count").textContent = inRoom ? `· ${t("hereCount", here)} · ${t("siteCount", people.length)}` : "";
  $("#n-page").textContent = inRoom ? here : "";
  $("#n-site").textContent = inRoom ? people.length : "";
  $("#leave").hidden = !inRoom;
  const unread = snap.dms.reduce((n, d) => n + d.unread, 0);
  $("#unread").hidden = !unread;
  $("#unread").textContent = unread;

  // Salon pas disponible ou pas rejoint
  let off = null;
  if (tab !== "dm") {
    if (!ctx) off = { title: t("noPage") };
    else if (ctx.incognito) off = { title: t("privateWindow") };
    else if (!settings.connected) off = { title: t("disconnected"), action: t("connect"), run: () => act("setSettings", { connected: true }) };
    else if (!ctx.enabled)
      off = { title: t("joinTitle", ctx.site), help: t("joinHelp"), action: t("join"), run: () => act("setSite", ctx.site, true) };
  }
  $("#off").hidden = !off;
  $("#room").hidden = !!off;
  if (off) {
    $("#off-title").textContent = off.title;
    $("#off-help").textContent = off.help ?? "";
    $("#off-action").hidden = !off.action;
    $("#off-action").textContent = off.action ?? "";
    $("#off-action").onclick = off.run ?? null;
  } else {
    renderRoom(status);
  }

  if (!$("#settings").hidden) renderSettings();
}

function renderRoom(status) {
  const { people, dms } = snap;
  const isDm = tab === "dm";

  $("#people").hidden = isDm;
  $("#dm-list").hidden = !isDm;
  $("#status").hidden = isDm || status === "open";
  $("#status").textContent = status === "error" ? t("connError") : t("connecting");

  if (!isDm) {
    const list = tab === "page" ? people.filter((p) => p.here) : people;
    $("#people").replaceChildren(
      ...(list.length ? list.map(personChip) : [el("span", { className: "muted", textContent: t(tab === "page" ? "nobodyPage" : "nobodySite") })])
    );
  } else {
    if (dmWith && !dms.some((d) => d.id === dmWith)) dmWith = null;
    dmWith ??= dms[0]?.id ?? null;
    $("#dm-list").replaceChildren(
      ...(dms.length
        ? dms.map((d) => {
            const chip = el(
              "span",
              { className: "person" + (d.id === dmWith ? " selected" : "") + (d.online ? "" : " away") },
              swatch(d.color),
              el("span", { textContent: d.name }),
              d.unread ? el("span", { className: "badge", textContent: d.unread }) : null
            );
            chip.style.cursor = "pointer";
            chip.addEventListener("click", () => {
              dmWith = d.id;
              render();
            });
            return chip;
          })
        : [el("span", { className: "muted", textContent: t("noDms") })])
    );
  }

  // Messages
  const thread = isDm ? dms.find((d) => d.id === dmWith) : null;
  const msgs = isDm ? thread?.msgs ?? [] : tab === "page" ? snap.pageChat : snap.siteChat;
  const key = `${tab}|${dmWith}|${msgs.length}|${msgs.at(-1)?.id}|${LANG}`;
  if (key !== lastChat) {
    lastChat = key;
    const box = $("#chat");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
    box.replaceChildren(...msgs.map(chatLine));
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
  if (thread?.unread && isDm) act("readDm", thread.id);

  // Saisie
  const input = $("#text");
  const canSend = isDm ? !!thread?.online : status === "open";
  input.disabled = !canSend;
  $("#send button").disabled = !canSend;
  input.placeholder = isDm
    ? thread
      ? thread.online
        ? t("dmPlaceholder", thread.name)
        : t("dmOffline", thread.name)
      : ""
    : t(tab === "page" ? "chatPagePlaceholder" : "chatSitePlaceholder");
}

function swatch(color) {
  const s = el("span", { className: "swatch" });
  s.style.background = color;
  return s;
}

function personChip(p) {
  const chip = el("span", { className: "person" }, swatch(p.color), el("span", { textContent: p.name }));
  if (tab === "site" && p.here) chip.append(el("span", { className: "tag muted", textContent: "· " + t("onPage") }));
  if (p.muted) chip.append(el("span", { className: "tag muted", textContent: "· " + t("mutedFlood") }));
  const dm = el("button", { textContent: "✉", title: t("sendDm") });
  dm.addEventListener("click", () => openDm(p.id));
  chip.append(dm, confirmButton("⛔", t("blockSure", p.name), () => act("block", p.id)));
  return chip;
}

function chatLine(m) {
  const time = el("time", { textContent: new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
  if (m.system) return el("li", { className: "system" }, time, t(m.key, ...(m.args ?? [])));
  const me = m.from === "me";
  const who = el("span", { className: "who" + (me ? " me" : ""), textContent: me ? t("you") : m.name });
  who.style.color = m.color;
  if (!me) {
    who.title = t("sendDm");
    who.addEventListener("click", () => openDm(m.from));
  }
  return el("li", {}, time, who, " ", m.text);
}

// --- Envoi --------------------------------------------------------------------------

function showError(text) {
  $("#error").hidden = !text;
  $("#error").textContent = text ?? "";
}

$("#send").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#text");
  const text = input.value.trim();
  if (!text) return;
  const error = tab === "dm" ? await ask("dm", dmWith, text) : await ask("chat", windowId, tab, text);
  if (error) return showError(t(error, snap.settings.sendRate));
  showError(null);
  input.value = "";
});

$("#leave").addEventListener("click", () => snap.ctx && act("setSite", snap.ctx.site, false));

// --- Réglages -----------------------------------------------------------------------

$("#open-settings").addEventListener("click", () => {
  $("#main").hidden = true;
  $("#settings").hidden = false;
  renderSettings(true);
});
$("#close-settings").addEventListener("click", () => {
  $("#settings").hidden = true;
  $("#main").hidden = false;
  render();
});

const set = (patch) => act("setSettings", patch);

$("#set-name").addEventListener("change", (e) => set({ name: e.target.value }));
$("#set-color").addEventListener("change", (e) => set({ color: e.target.value }));
$("#set-view").addEventListener("change", (e) => set({ view: e.target.value }));
$("#set-lang").addEventListener("change", (e) => set({ lang: e.target.value }));
for (const k of ["showCursors", "shareCursor", "shareSelection", "autoJoin"]) {
  $(`#set-${k}`).addEventListener("change", (e) => set({ [k]: e.target.checked }));
}
for (const k of ["sendRate", "recvRate"]) {
  $(`#set-${k}`).addEventListener("change", (e) => set({ [k]: e.target.value }));
}
$("#toggle-connected").addEventListener("click", () => set({ connected: !snap.settings.connected }));

// Les champs en cours d'édition ne sont pas écrasés par l'état reçu
function fill(sel, prop, value, force) {
  const e = $(sel);
  if (force || document.activeElement !== e) e[prop] = value;
}

function renderSettings(force = false) {
  const s = snap.settings;
  fill("#set-name", "value", s.name, force);
  fill("#set-color", "value", s.color, force);
  fill("#set-view", "value", s.view, force);
  fill("#set-lang", "value", s.lang, force);
  fill("#set-sendRate", "value", s.sendRate, force);
  fill("#set-recvRate", "value", s.recvRate, force);
  for (const k of ["showCursors", "shareCursor", "shareSelection", "autoJoin"]) fill(`#set-${k}`, "checked", s[k], true);

  const swatches = snap.palette.map((c) => {
    const b = el("button", { className: c === s.color ? "on" : "", title: c });
    b.style.background = c;
    b.addEventListener("click", () => set({ color: c }));
    return b;
  });
  $("#swatches").replaceChildren(...swatches, $("#set-color"));

  const btn = $("#toggle-connected");
  btn.textContent = t(s.connected ? "disconnectAll" : "connect");
  btn.className = s.connected ? "danger" : "primary";

  const sites = Object.entries(s.sites).sort(([a], [b]) => a.localeCompare(b));
  $("#sites").replaceChildren(
    ...(sites.length
      ? sites.map(([site, on]) => {
          const forget = el("button", { className: "small", textContent: t("forget") });
          forget.addEventListener("click", () => act("forgetSite", site));
          return el("li", {}, el("span", { textContent: site }), el("span", { className: "muted", textContent: t(on ? "siteAlways" : "siteNever") }), forget);
        })
      : [el("li", { className: "muted", textContent: t("noSites") })])
  );

  const blocked = Object.entries(s.blocked);
  $("#blocked").replaceChildren(
    ...(blocked.length
      ? blocked.map(([id, name]) => {
          const b = el("button", { className: "small", textContent: t("unblock") });
          b.addEventListener("click", () => act("unblock", id));
          return el("li", {}, el("span", { textContent: `${name} · ${id.slice(0, 8)}` }), b);
        })
      : [el("li", { className: "muted", textContent: t("noBlocked") })])
  );

  $("#log").textContent = snap.log.join("\n");
}
