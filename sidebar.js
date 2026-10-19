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
  heard();
  if (setLang(snap.settings.lang) || !translated) {
    translated = true;
    applyI18n();
    lastChat = "";
  }
  render();
});

// Son à chaque nouveau message des autres (réglage commun), dans les salons de l'onglet
// actif et les messages privés. Le premier état reçu ne sonne pas.
let lastHeard = null;
function heard() {
  let last = 0;
  for (const list of [snap.page?.chat, snap.site?.chat, ...snap.dms.map((d) => d.msgs)]) {
    for (const m of list ?? []) if (!m.system && m.from !== "me" && m.id > last) last = m.id;
  }
  if (lastHeard !== null && last > lastHeard && snap.settings.chatSound) beep();
  lastHeard = Math.max(lastHeard ?? 0, last);
}

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

// Fiche d'une personne (clic sur son nom) : message privé, dessins, blocage. Bloquer
// demande une étape de plus, avec ses conséquences écrites : pas de blocage par mégarde.
let person = null; // { id, confirm }

function openPerson(id) {
  person = { id, confirm: false };
  render();
}

function closePerson() {
  person = null;
  render();
}

function renderPerson() {
  const box = $("#person");
  const known = [...(snap.page?.people ?? []), ...(snap.site?.people ?? []), ...snap.dms].find((p) => p.id === person?.id);
  box.hidden = !known;
  if (!known) return;
  const close = el("button", { className: "small", textContent: "✕", title: t("close") });
  close.addEventListener("click", closePerson);
  const head = el(
    "div",
    { className: "head" },
    swatch(known.color),
    el("strong", { textContent: known.name }),
    codeTag(known.code),
    el("span", { className: "grow" }),
    close
  );
  if (person.confirm) {
    const yes = el("button", { className: "danger", textContent: t("blockConfirm", known.name) });
    yes.addEventListener("click", () => {
      act("block", known.id);
      if (dmWith === known.id) dmWith = null;
      closePerson();
    });
    const no = el("button", { textContent: t("cancel") });
    no.addEventListener("click", () => {
      person.confirm = false;
      render();
    });
    box.replaceChildren(
      head,
      el("p", { className: "warn", textContent: t("blockConfirmTitle", known.name) }),
      el("p", { className: "muted", textContent: t("blockConfirmHelp") }),
      el("div", { className: "actions" }, yes, no)
    );
    return;
  }
  const inkHidden = !!snap.settings.hiddenInk[known.id];
  const dm = el("button", { textContent: "✉ " + t("privateMessage") });
  dm.addEventListener("click", () => {
    person = null;
    openDm(known.id);
  });
  const inkBtn = el("button", { textContent: "✏️ " + t(inkHidden ? "inkShow" : "inkHide") });
  inkBtn.addEventListener("click", () => act("toggleInk", known.id));
  const block = el("button", { className: "subtle-danger", textContent: "⛔ " + t("blockAsk") });
  block.addEventListener("click", () => {
    person.confirm = true;
    render();
  });
  box.replaceChildren(head, el("div", { className: "actions" }, dm, inkBtn, block));
}

// --- Affichage ------------------------------------------------------------------------

function render() {
  if (!snap) return;
  const { settings, ctx } = snap;

  // Calcul de la preuve de travail au premier lancement : les essais sont tirés au hasard,
  // l'avancement n'est qu'une estimation (plafonnée à 99 %)
  $("#mining").hidden = !snap.mining;
  if (snap.mining) {
    const pct = Math.min(99, Math.round((snap.mining.tries / snap.mining.expected) * 100));
    $("#mining-title").textContent = t("identityMining", pct);
    $("#mining-bar").value = pct;
  }

  // Salons affichés selon le réglage
  $("#tabs [data-tab=page]").hidden = settings.view === "site";
  $("#tabs [data-tab=site]").hidden = settings.view === "page";
  if ((tab === "page" && settings.view === "site") || (tab === "site" && settings.view === "page")) {
    tab = settings.view === "site" ? "site" : "page";
  }
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("on", b.dataset.tab === tab);

  // En-tête
  const inRoom = ctx?.enabled && !ctx.incognito;
  const room = tab === "site" ? snap.site : snap.page;
  const status = inRoom ? room?.status ?? "connecting" : "off";
  $("#dot").className = status;
  $("#site").textContent = ctx?.site ?? "Pagemates";
  // Les nombres de personnes sont dans les onglets
  const here = snap.page?.people.length ?? 0;
  const onSite = snap.site?.people.length;
  $("#n-page").textContent = inRoom ? here : "";
  $("#n-site").textContent = inRoom && onSite != null ? onSite : "";
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
    renderRoom(room, status);
  }

  if (!$("#settings").hidden) renderSettings();
}

function renderRoom(room, status) {
  const { dms } = snap;
  const isDm = tab === "dm";
  const people = room?.people ?? [];

  renderWhere(room);
  renderTools();
  renderPerson();
  $("#people").hidden = isDm;
  $("#dm-list").hidden = !isDm;
  $("#status").hidden = isDm || status === "open";
  $("#status").textContent = status === "error" ? t("connError") : t("connecting");

  if (!isDm) {
    $("#people").replaceChildren(
      ...(people.length ? people.map(personChip) : [el("span", { className: "muted", textContent: t(tab === "page" ? "nobodyPage" : "nobodySite") })])
    );
  } else {
    if (dmWith && !dms.some((d) => d.id === dmWith)) dmWith = null;
    dmWith ??= dms[0]?.id ?? null;
    $("#dm-list").replaceChildren(
      ...(dms.length
        ? dms.map((d) => {
            const chip = el(
              "span",
              { className: "chip" + (d.id === dmWith ? " selected" : "") + (d.online ? "" : " away") },
              swatch(d.color),
              el("span", { textContent: d.name }),
              codeTag(d.code),
              d.unread ? el("span", { className: "badge", textContent: d.unread }) : null,
              more(d.id)
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
  const msgs = isDm ? thread?.msgs ?? [] : room?.chat ?? [];
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

// --- Où l'on se trouve : adresse du salon et canal --------------------------------------

const decode = (s) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
};
const short = (s, n = 18) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// Un morceau d'adresse cliquable ; barré quand il ne compte pas pour le salon
function token(text, on, title, onClick) {
  const b = el("button", { className: "token" + (on ? "" : " off"), textContent: text, title });
  b.addEventListener("click", onClick);
  return b;
}

// Onglet Site : le site. Onglet Page : l'adresse en morceaux. Un clic sur un paramètre
// l'inclut ou l'exclut ; un clic sur un morceau du chemin coupe l'adresse après lui
// (un salon par section), un nouveau clic la rétablit en entier.
function renderWhere(room) {
  const where = $("#where");
  where.hidden = tab === "dm" || !snap.ctx;
  if (where.hidden) return;
  const { site, parts } = snap.ctx;
  const items = [el("strong", { className: "where-site", textContent: site })];
  if (tab === "page" && parts) {
    const kept = parts.depth ?? parts.segments.length;
    parts.segments.forEach((seg, i) => {
      const on = i < kept;
      let next = on && i + 1 === kept ? null : i + 1;
      if (next === parts.segments.length) next = null;
      const title = on ? (i + 1 === kept ? (parts.depth == null ? t("pathLast") : t("pathRestore")) : t("pathCut")) : t("pathExtend");
      items.push(token("/" + short(decode(seg), 24), on, title, () => act("setPageDepth", site, next)));
    });
    parts.params.forEach((p, i) => {
      const label = (i ? "&" : "?") + p.name + (p.value ? "=" + short(decode(p.value)) : "");
      items.push(token(label, p.on, t(p.on ? "paramExclude" : "paramInclude", p.name), () => act("setPageParam", site, p.name, !p.on)));
    });
    if (parts.custom) {
      const reset = el("button", { className: "token reset", textContent: "↺", title: t("pageReset") });
      reset.addEventListener("click", () => act("resetPage", site));
      items.push(reset);
    }
  }
  const path = $("#where-path");
  path.replaceChildren(...items);
  path.title = tab === "page" ? t("whereHelpPage") : t("whereHelpSite");
  renderChannel(room);
}

// Canal : un bouton « Canal #1 · 3/20 ▾ » ouvre la liste des canaux, avec un champ pour
// aller sur un numéro (donné par des amis, par exemple)
let channelOpen = false;
const goInput = $("#channel-go input");

function renderChannel(room) {
  const box = $("#channel");
  box.hidden = !room?.inst;
  if (box.hidden) return;
  const count = room.instances.find((x) => x.n === room.inst)?.count ?? 1;
  $("#channel-btn").textContent = `${t("channel")} #${room.inst} · ${count}/${snap.instanceSize} ▾`;
  $("#channel-menu").hidden = !channelOpen;
  $("#channel-list").replaceChildren(
    ...room.instances.map(({ n, count }) => {
      const b = el("button", { className: "small" + (n === room.inst ? " on" : ""), textContent: `#${n} · ${count}/${snap.instanceSize}` });
      b.title = n === room.inst ? t("instanceCurrent") : t("instanceJoin", n);
      b.addEventListener("click", () => {
        closeChannel();
        if (n !== room.inst) switchInstance(n);
      });
      return b;
    })
  );
}

function closeChannel() {
  channelOpen = false;
  $("#channel-menu").hidden = true;
}

$("#channel-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  channelOpen = !channelOpen;
  render();
  if (channelOpen) goInput.focus();
});
$("#channel-menu").addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => channelOpen && closeChannel());
document.addEventListener("keydown", (e) => e.key === "Escape" && channelOpen && closeChannel());
$("#channel-go").addEventListener("submit", (e) => {
  e.preventDefault();
  const n = Number(goInput.value);
  if (!n) return;
  goInput.value = "";
  closeChannel();
  switchInstance(n);
});

// Outils de dessin (onglet Page) : mode dessin, effacer nos dessins de la page (nos propres
// données : confirmation légère « Sûr ? » du kit commun)
const sure = createSure(() => render());

function renderTools() {
  const box = $("#tools");
  const ctx = snap.ctx;
  box.hidden = tab !== "page" || !snap.page?.inst;
  if (box.hidden) return;
  const drawBtn = el("button", { className: ctx.drawMode ? "on" : "", textContent: t(ctx.drawMode ? "drawing" : "draw"), title: t("drawHint") });
  drawBtn.addEventListener("click", async () => {
    const error = await ask("drawMode", windowId, !ctx.drawMode);
    showError(error ? t(error) : null);
  });
  const items = [drawBtn];
  if (ctx.myInk) {
    const armed = sure.armed("clearInk");
    const clear = el("button", { className: "small" + (armed ? " danger" : ""), textContent: armed ? t("sure") : t("clearInk", ctx.myInk) });
    clear.title = t("clearInkSure", ctx.myInk);
    clear.addEventListener("click", () => sure.click("clearInk", () => act("clearInk", windowId)));
    items.push(clear);
  }
  box.replaceChildren(...items);
}

async function switchInstance(n) {
  const error = await ask("setInstance", windowId, tab, n);
  showError(error ? t(error) : null);
}

function swatch(color) {
  const s = el("span", { className: "swatch" });
  s.style.background = color;
  return s;
}

// Bouton « ⋯ » : ouvre la fiche de la personne
function more(id) {
  const b = el("button", { textContent: "⋯", title: t("personMenu") });
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    openPerson(id);
  });
  return b;
}

// Code de 4 caractères lié à l'identité : deux personnes au même pseudo n'ont pas le même
function codeTag(code) {
  return code ? el("span", { className: "code", textContent: code, title: t("codeHelp") }) : null;
}

function personChip(p) {
  const chip = el(
    "button",
    { className: "chip" + (person?.id === p.id ? " selected" : ""), title: t("personMenu") },
    swatch(p.color),
    el("span", { textContent: p.name }),
    codeTag(p.code)
  );
  chip.addEventListener("click", () => (person?.id === p.id ? closePerson() : openPerson(p.id)));
  if (p.inkHidden) chip.append(el("span", { className: "tag muted", textContent: "· " + t("inkHiddenTag") }));
  if (tab === "site" && p.here) chip.append(el("span", { className: "tag muted", textContent: "· " + t("onPage") }));
  if (p.muted) chip.append(el("span", { className: "tag muted", textContent: "· " + t("mutedFlood") }));
  return chip;
}

function chatLine(m) {
  const time = el("time", { textContent: new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
  if (m.system) return el("li", { className: "msg system" }, time, t(m.key, ...(m.args ?? [])));
  const me = m.from === "me";
  const who = el("span", { className: "who" + (me ? " me" : ""), textContent: me ? t("you") : m.name });
  who.style.color = m.color;
  if (!me) {
    const code = [...(snap.page?.people ?? []), ...(snap.site?.people ?? []), ...snap.dms].find((p) => p.id === m.from)?.code;
    who.title = (code ? code + " · " : "") + t("personMenu");
    who.addEventListener("click", () => openPerson(m.from));
  }
  return el("li", { className: "msg" }, time, who, " ", m.text);
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
  if (error) return showError(t(error, snap.sendRate));
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
for (const k of ["showCursors", "shareCursor", "shareSelection", "autoJoin", "chatSound"]) {
  $(`#set-${k}`).addEventListener("change", (e) => set({ [k]: e.target.checked }));
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
  $("#my-code").textContent = snap.myCode || "…";
  fill("#set-color", "value", s.color, force);
  fill("#set-view", "value", s.view, force);
  fill("#set-lang", "value", s.lang, force);
  for (const k of ["showCursors", "shareCursor", "shareSelection", "autoJoin", "chatSound"]) fill(`#set-${k}`, "checked", s[k], true);

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
          // « Nom · CODE » depuis 0.6 ; avant, le nom seul : on ajoute le début de l'identité
          return el("li", {}, el("span", { textContent: name.includes("·") ? name : `${name} · ${id.slice(0, 8)}` }), b);
        })
      : [el("li", { className: "muted", textContent: t("noBlocked") })])
  );

  $("#log").textContent = snap.log.join("\n");
}
