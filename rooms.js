// Salons : un salon par site, dont chaque page est un sous-salon.
//
// Toutes les personnes d'un même site sont reliées en pair-à-pair (PeerJS : son serveur
// public ne sert qu'à mettre les navigateurs en relation). Chacun annonce aux autres les
// pages qu'il a ouvertes sur ce site, sous forme d'empreintes : le chat de page, les
// curseurs et les surlignages ne partent que vers ceux qui sont sur la même page.
//
// Pour se trouver, chacun publie sa présence sur des relais Nostr publics, étiquetée
// avec l'empreinte du site (jamais l'adresse en clair), signée avec une clé jetable.
//
// Chaque personne a une identité durable (clé Nostr locale) : elle signe la poignée de
// main de chaque connexion, ce qui empêche de se faire passer pour quelqu'un d'autre en
// MP et permet de bloquer une personne pour de bon.

const NOSTR_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net", "wss://nostr.mom"];
const PRESENCE_EVERY = 60 * 1000;
const PRESENCE_TTL = 150; // secondes
const MAX_PEERS = 24; // au-delà, on ne se connecte plus à de nouvelles personnes sur ce site
const CHAT_LIMIT = 200;
const TEXT_MAX = 500;
const HELLO_KIND = 27235; // éphémère : jamais publié, sert seulement à signer la poignée de main

// Anti-flood à la réception, par personne : au-delà, les messages sont ignorés, et une
// personne qui insiste est mise en sourdine une minute
const LIVE_PER_SECOND = 40; // curseurs, clics, surlignages
const META_PER_SECOND = 4; // profil, liste des pages
const FLOOD_DROPS = 30;
const FLOOD_MUTE = 60 * 1000;

// siteKey → session
const sessions = new Map();

let nostrPool = null;
const pool = () => (nostrPool ??= new NostrTools.SimplePool());
const nowSeconds = () => Math.floor(Date.now() / 1000);

// Compteur glissant sur une seconde
function rateOk(times, limit, now = Date.now()) {
  while (times.length && now - times[0] >= 1000) times.shift();
  if (times.length >= limit) return false;
  times.push(now);
  return true;
}

// --- Ouverture et fermeture d'un salon de site ------------------------------------------

function startSession(siteKey, site) {
  if (sessions.has(siteKey)) return sessions.get(siteKey);
  const peer = new Peer();
  const s = {
    key: siteKey,
    site,
    tag: "pagemates-" + siteKey,
    peer,
    peerId: null,
    status: "connecting",
    nostrKey: NostrTools.generateSecretKey(), // jetable : rien ne relie deux sessions
    presenceTimer: null,
    sub: null,
    members: new Map(), // pubkey → membre
    pending: new Map(), // peerId → connexion en attente de poignée de main
    chat: [],
    pageChats: new Map(), // pageKey → messages
  };
  sessions.set(siteKey, s);

  peer.on("open", (id) => {
    s.peerId = id;
    s.status = "open";
    publishPresence(s);
    s.presenceTimer = setInterval(() => publishPresence(s), PRESENCE_EVERY);
    subscribePresence(s);
    update();
  });
  peer.on("connection", (conn) => setupConn(s, conn));
  peer.on("disconnected", () => {
    if (sessions.get(siteKey) === s && !peer.destroyed) peer.reconnect();
  });
  peer.on("error", (e) => {
    if (sessions.get(siteKey) !== s) return;
    if (e.type === "peer-unavailable") return; // une présence périmée : la personne est partie
    log(`PeerJS (${site}) : ${e.type}`);
    if (["network", "server-error", "socket-error", "browser-incompatible"].includes(e.type)) {
      s.status = "error";
      update();
    }
  });
  update();
  return s;
}

function endSession(siteKey) {
  const s = sessions.get(siteKey);
  if (!s) return;
  sessions.delete(siteKey);
  clearInterval(s.presenceTimer);
  s.sub?.close();
  if (s.peerId) publishPresence(s, true);
  for (const m of s.members.values()) safeSend(m.conn, { t: "bye" });
  setTimeout(() => s.peer.destroy(), 300); // laisse partir les messages d'au revoir
  update();
  for (const tab of tabsOnSite(siteKey)) pushPeers(tab);
}

// --- Présence sur Nostr -------------------------------------------------------------

function publishPresence(s, leaving = false) {
  const created = nowSeconds();
  const event = NostrTools.finalizeEvent(
    {
      kind: 30078,
      created_at: created,
      tags: [["d", s.tag], ["t", s.tag], ["expiration", String(created + (leaving ? 30 : PRESENCE_TTL))]],
      content: JSON.stringify(leaving ? { v: 1, left: true } : { v: 1, peer: s.peerId }),
    },
    s.nostrKey
  );
  Promise.allSettled(pool().publish(NOSTR_RELAYS, event)).then((results) => {
    if (!results.some((r) => r.status === "fulfilled")) log(t("logPresenceFailed"));
  });
}

function subscribePresence(s) {
  s.sub = pool().subscribeMany(NOSTR_RELAYS, [{ kinds: [30078], "#t": [s.tag], since: nowSeconds() - PRESENCE_TTL }], {
    onevent(e) {
      if (sessions.get(s.key) !== s) return;
      const expiration = Number(e.tags.find((tag) => tag[0] === "expiration")?.[1] ?? 0);
      if (expiration && expiration < nowSeconds()) return;
      let c;
      try {
        c = JSON.parse(e.content);
      } catch {
        return;
      }
      if (c.left || typeof c.peer !== "string" || c.peer.length > 64) return;
      discovered(s, c.peer);
    },
  });
}

// Une personne s'est annoncée sur ce site. Pour éviter les doubles connexions, c'est celui
// dont l'identifiant est le plus petit qui appelle ; l'autre attend l'appel.
function discovered(s, peerId) {
  if (!s.peerId || peerId === s.peerId || peerId > s.peerId) return;
  if (s.pending.has(peerId) || [...s.members.values()].some((m) => m.conn.peer === peerId)) return;
  if (s.members.size + s.pending.size >= MAX_PEERS) return;
  setupConn(s, s.peer.connect(peerId, { serialization: "json", reliable: true }));
}

// --- Connexions et poignée de main ----------------------------------------------------

function safeSend(conn, msg) {
  try {
    if (conn?.open) conn.send(msg);
  } catch {
    // connexion en train de tomber : le « close » suivra
  }
}

function setupConn(s, conn) {
  if (s.members.size + s.pending.size >= MAX_PEERS) {
    conn.on("open", () => conn.close());
    return;
  }
  s.pending.set(conn.peer, conn);
  const timeout = setTimeout(() => {
    if (s.pending.get(conn.peer) === conn) conn.close();
  }, 15000);

  conn.on("open", () => {
    const ev = NostrTools.finalizeEvent(
      {
        kind: HELLO_KIND,
        created_at: nowSeconds(),
        tags: [["from", s.peerId], ["to", conn.peer], ["site", s.key]],
        content: "",
      },
      identity.secret
    );
    safeSend(conn, { t: "hello", ev, ...profileFor(s) });
  });
  conn.on("data", (msg) => {
    clearTimeout(timeout);
    onData(s, conn, msg);
  });
  conn.on("close", () => dropConn(s, conn));
  conn.on("error", () => dropConn(s, conn));
}

function profileFor(s) {
  return { name: settings.name, color: settings.color, pages: pagesOnSite(s.key) };
}

function dropConn(s, conn) {
  if (s.pending.get(conn.peer) === conn) s.pending.delete(conn.peer);
  for (const m of s.members.values()) {
    if (m.conn !== conn) continue;
    s.members.delete(m.id);
    if (sessions.get(s.key) !== s) return;
    systemMessage(s.chat, "sysLeftSite", m.name);
    for (const page of m.pages) if (hasPage(s, page)) systemMessage(pageChat(s, page), "sysLeftPage", m.name);
    pushPeersForSite(s);
    update();
  }
}

function verifyHello(s, conn, msg) {
  const ev = msg?.ev;
  if (!ev || typeof ev !== "object" || ev.kind !== HELLO_KIND) return null;
  try {
    if (!NostrTools.verifyEvent(ev)) return null;
  } catch {
    return null; // événement mal formé
  }
  const tag = (k) => ev.tags.find((x) => x[0] === k)?.[1];
  if (tag("from") !== conn.peer || tag("to") !== s.peerId || tag("site") !== s.key) return null;
  if (Math.abs(nowSeconds() - ev.created_at) > 300) return null;
  return ev.pubkey;
}

function cleanName(name) {
  return String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 24) || "?";
}

function cleanColor(color) {
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : "#888888";
}

function cleanPages(pages) {
  return new Set((Array.isArray(pages) ? pages : []).filter((p) => typeof p === "string" && /^[0-9a-f]{32}$/.test(p)).slice(0, 20));
}

function onData(s, conn, msg) {
  if (sessions.get(s.key) !== s || !msg || typeof msg !== "object") return;

  if (msg.t === "hello" && s.pending.get(conn.peer) === conn) {
    const id = verifyHello(s, conn, msg);
    if (!id || id === identity.pubkey || settings.blocked[id]) return conn.close();
    s.pending.delete(conn.peer);
    // Déjà connecté à cette personne (reconnexion) : la nouvelle connexion remplace l'ancienne
    const old = s.members.get(id);
    if (old) old.conn.close();
    const m = {
      id,
      conn,
      name: cleanName(msg.name),
      color: cleanColor(msg.color),
      pages: cleanPages(msg.pages),
      chatTimes: [],
      liveTimes: [],
      metaTimes: [],
      drops: [],
      mutedUntil: 0,
    };
    s.members.set(id, m);
    if (!old) {
      systemMessage(s.chat, "sysJoinedSite", m.name);
      for (const page of m.pages) if (hasPage(s, page)) systemMessage(pageChat(s, page), "sysJoinedPage", m.name);
    }
    knownPeople.set(id, { name: m.name, color: m.color });
    pushPeersForSite(s);
    update();
    return;
  }

  const m = [...s.members.values()].find((x) => x.conn === conn);
  if (!m) return;
  const now = Date.now();
  if (m.mutedUntil > now) return;

  const live = msg.t === "cur" || msg.t === "click" || msg.t === "sel";
  const chatty = msg.t === "chat" || msg.t === "dm";
  const ok = live
    ? rateOk(m.liveTimes, LIVE_PER_SECOND, now)
    : chatty
      ? rateOk(m.chatTimes, settings.recvRate, now)
      : rateOk(m.metaTimes, META_PER_SECOND, now);
  if (!ok) return flooded(s, m, now);

  switch (msg.t) {
    case "profile": {
      const name = cleanName(msg.name);
      const color = cleanColor(msg.color);
      if (name !== m.name) systemMessage(s.chat, "sysRenamed", m.name, name);
      Object.assign(m, { name, color });
      knownPeople.set(m.id, { name, color });
      pushPeersForSite(s);
      update();
      break;
    }
    case "pages": {
      const next = cleanPages(msg.pages);
      for (const page of next) if (!m.pages.has(page) && hasPage(s, page)) systemMessage(pageChat(s, page), "sysJoinedPage", m.name);
      for (const page of m.pages) if (!next.has(page) && hasPage(s, page)) systemMessage(pageChat(s, page), "sysLeftPage", m.name);
      m.pages = next;
      pushPeersForSite(s);
      update();
      break;
    }
    case "chat": {
      const text = String(msg.text ?? "").slice(0, TEXT_MAX).trim();
      if (!text) return;
      if (msg.scope === "page") {
        if (!m.pages.has(msg.page) || !hasPage(s, msg.page)) return;
        addChat(pageChat(s, msg.page), { from: m.id, name: m.name, color: m.color, text });
      } else {
        addChat(s.chat, { from: m.id, name: m.name, color: m.color, text });
      }
      update();
      break;
    }
    case "dm": {
      const text = String(msg.text ?? "").slice(0, TEXT_MAX).trim();
      if (text) receiveDm(m, text);
      break;
    }
    case "cur":
    case "click":
    case "sel": {
      if (!m.pages.has(msg.page)) return;
      const payload = msg.t === "sel" ? (msg.q == null ? null : cleanQuote(msg.q)) : msg.a == null ? null : cleanAnchor(msg.a);
      if (payload === undefined || (msg.t === "click" && !payload)) return;
      for (const tab of tabsOnPage(msg.page)) {
        tab.port.postMessage(msg.t === "sel" ? { t: "sel", id: m.id, q: payload } : { t: msg.t, id: m.id, a: payload });
      }
      break;
    }
    case "bye":
      conn.close();
      break;
  }
}

function flooded(s, m, now) {
  m.drops.push(now);
  while (m.drops.length && now - m.drops[0] > 10000) m.drops.shift();
  if (m.drops.length < FLOOD_DROPS) return;
  m.drops = [];
  m.mutedUntil = now + FLOOD_MUTE;
  systemMessage(s.chat, "sysFlood", m.name);
  update();
}

// --- Validation de ce qui arrive des autres (rien n'est pris tel quel) -----------------

const num01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

// undefined = message invalide
function cleanAnchor(a) {
  if (!a || typeof a !== "object" || !Array.isArray(a.p) || a.p.length > 60) return undefined;
  const p = [];
  for (const step of a.p) {
    if (!Array.isArray(step) || typeof step[0] !== "string" || !/^[a-z][a-z0-9-]{0,40}$/.test(step[0])) return undefined;
    const i = Number(step[1]);
    if (!Number.isInteger(i) || i < 0 || i > 100000) return undefined;
    p.push([step[0], i]);
  }
  return {
    r: typeof a.r === "string" ? a.r.slice(0, 64) : "",
    p,
    x: num01(a.x),
    y: num01(a.y),
    h: Number.isInteger(a.h) && a.h >= 0 ? a.h : 0,
    fx: num01(a.fx),
    fy: num01(a.fy),
  };
}

function cleanQuote(q) {
  if (!q || typeof q !== "object" || typeof q.exact !== "string" || !q.exact.trim()) return undefined;
  return {
    exact: q.exact.slice(0, 1000),
    prefix: String(q.prefix ?? "").slice(-32),
    suffix: String(q.suffix ?? "").slice(0, 32),
  };
}

// --- Chat --------------------------------------------------------------------------

let chatSeq = 0;

function addChat(list, entry) {
  list.push({ id: ++chatSeq, at: Date.now(), ...entry });
  if (list.length > CHAT_LIMIT) list.shift();
}

// Message système : clé de traduction, lue dans la langue de chacun à l'affichage
function systemMessage(list, key, ...args) {
  addChat(list, { system: true, key, args });
}

function pageChat(s, page) {
  if (!s.pageChats.has(page)) s.pageChats.set(page, []);
  return s.pageChats.get(page);
}

function hasPage(s, page) {
  return pagesOnSite(s.key).includes(page);
}

// Envoi depuis la barre latérale : scope "site" ou "page"
function sendChat(tab, scope, text) {
  const s = sessions.get(tab?.siteKey);
  if (!s || s.status !== "open") return "errNotConnected";
  text = String(text ?? "").slice(0, TEXT_MAX).trim();
  if (!text) return null;
  if (!rateOk(sendTimes, settings.sendRate)) return "errTooFast";
  const me = { from: "me", name: settings.name, color: settings.color, text };
  if (scope === "page") {
    for (const m of s.members.values()) if (m.pages.has(tab.pageKey)) safeSend(m.conn, { t: "chat", scope, page: tab.pageKey, text });
    addChat(pageChat(s, tab.pageKey), me);
  } else {
    for (const m of s.members.values()) safeSend(m.conn, { t: "chat", scope: "site", text });
    addChat(s.chat, me);
  }
  update();
  return null;
}

// --- Messages privés -------------------------------------------------------------------

// pubkey → { msgs: [], unread }
const dms = new Map();
// Dernier nom et dernière couleur connus de chaque personne croisée (pour les MP)
const knownPeople = new Map();

function dmThread(id) {
  if (!dms.has(id)) dms.set(id, { msgs: [], unread: 0 });
  return dms.get(id);
}

function receiveDm(m, text) {
  const thread = dmThread(m.id);
  addChat(thread.msgs, { from: m.id, name: m.name, color: m.color, text });
  thread.unread++;
  update();
}

// Une personne peut être jointe en MP tant qu'on partage un site avec elle
function memberAnywhere(id) {
  for (const s of sessions.values()) {
    const m = s.members.get(id);
    if (m?.conn.open) return m;
  }
  return null;
}

function sendDm(id, text) {
  const m = memberAnywhere(id);
  if (!m) return "errDmOffline";
  text = String(text ?? "").slice(0, TEXT_MAX).trim();
  if (!text) return null;
  if (!rateOk(sendTimes, settings.sendRate)) return "errTooFast";
  safeSend(m.conn, { t: "dm", text });
  addChat(dmThread(id).msgs, { from: "me", name: settings.name, color: settings.color, text });
  update();
  return null;
}

// --- Ce qui part de nos pages (curseur, clic, surlignage) ------------------------------

function relayLive(tab, msg) {
  const s = sessions.get(tab.siteKey);
  if (!s || !tab.pageKey) return;
  if (msg.t === "sel" ? !settings.shareSelection : !settings.shareCursor) return;
  if (!rateOk(tab.liveTimes, LIVE_PER_SECOND / 2)) return;
  const payload = msg.t === "sel" ? (msg.q == null ? null : cleanQuote(msg.q)) : msg.a == null ? null : cleanAnchor(msg.a);
  if (payload === undefined) return;
  const out = msg.t === "sel" ? { t: "sel", page: tab.pageKey, q: payload } : { t: msg.t, page: tab.pageKey, a: payload };
  for (const m of s.members.values()) if (m.pages.has(tab.pageKey)) safeSend(m.conn, out);
}

// --- Diffusion de nos changements --------------------------------------------------

function broadcastProfile() {
  for (const s of sessions.values()) {
    for (const m of s.members.values()) safeSend(m.conn, { t: "profile", name: settings.name, color: settings.color });
  }
}

// Pages ouvertes sur un site changées : on prévient les membres du site
function broadcastPages(siteKey) {
  const s = sessions.get(siteKey);
  if (!s) return;
  const pages = pagesOnSite(siteKey);
  const json = JSON.stringify(pages);
  if (json === s.lastPages) return;
  s.lastPages = json;
  for (const m of s.members.values()) safeSend(m.conn, { t: "pages", pages });
}

function block(id) {
  const name = knownPeople.get(id)?.name ?? "?";
  settings.blocked[id] = name;
  saveSettings();
  for (const s of sessions.values()) {
    const m = s.members.get(id);
    if (m) m.conn.close();
  }
  dms.delete(id);
  update();
}

// Membres d'un site présents sur une page donnée
function peopleOnPage(s, page) {
  return [...s.members.values()].filter((m) => m.pages.has(page));
}

function pushPeersForSite(s) {
  for (const tab of tabsOnSite(s.key)) pushPeers(tab);
}
