// Salons : chaque page ouverte a son salon, et chaque site le sien.
//
// Les personnes d'un salon sont reliées en pair-à-pair (PeerJS : son serveur public ne
// sert qu'à mettre les navigateurs en relation). Le salon de page porte le chat de page,
// les curseurs et les surlignages ; le salon de site, le chat du site.
//
// Instances : comme dans un jeu en ligne, un salon ne dépasse pas INSTANCE_SIZE personnes.
// Au-delà, les nouveaux arrivants ouvrent l'instance suivante (#2, #3…), et chacun peut
// changer d'instance à la main. Sans ça, chacun serait relié à un morceau différent de
// la foule et le chat deviendrait incohérent.
//
// Pour se trouver, chacun publie sa présence sur des relais Nostr publics, étiquetée
// avec l'empreinte du salon (jamais l'adresse en clair), signée avec une clé jetable.
// La présence indique l'instance : c'est ce qui permet de compter qui est où.
//
// Chaque personne a une identité durable (clé Nostr locale) : elle signe la poignée de
// main de chaque connexion, ce qui empêche de se faire passer pour quelqu'un d'autre en
// MP et permet de bloquer une personne pour de bon.

const NOSTR_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net", "wss://nostr.mom"];
const PRESENCE_EVERY = 60 * 1000;
const PRESENCE_TTL = 150; // secondes
const INSTANCE_SIZE = 20; // taille visée d'une instance
const MAX_PEERS = 24; // limite dure : un peu de marge quand plusieurs arrivent en même temps
const PICK_WAIT = 3000; // temps laissé aux relais pour dire qui est déjà là, avant de choisir l'instance
const CHAT_LIMIT = 200;
const TEXT_MAX = 500;
const HELLO_KIND = 27235; // éphémère : jamais publié, sert seulement à signer la poignée de main

// Anti-flood à la réception, par personne : au-delà, les messages sont ignorés, et une
// personne qui insiste est mise en sourdine une minute
const LIVE_PER_SECOND = 40; // curseurs, clics, surlignages
const META_PER_SECOND = 4; // profil
const FLOOD_DROPS = 30;
const FLOOD_MUTE = 60 * 1000;

// roomKey → salon
const rooms = new Map();
// siteKey → { peer, id, status, rooms: Set } : un seul PeerJS par site, partagé par ses salons
const sitePeers = new Map();

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

// --- PeerJS partagé par les salons d'un site ----------------------------------------------

function acquirePeer(siteKey, site) {
  let sp = sitePeers.get(siteKey);
  if (sp) return sp;
  const peer = new Peer();
  sp = { peer, id: null, status: "connecting", rooms: new Set() };
  sitePeers.set(siteKey, sp);
  peer.on("open", (id) => {
    sp.id = id;
    sp.status = "open";
    for (const room of sp.rooms) roomReady(room);
    update();
  });
  // Chaque connexion dit à quel salon elle s'adresse
  peer.on("connection", (conn) => {
    const room = [...sp.rooms].find((r) => r.key === conn.metadata?.room);
    if (room) setupConn(room, conn);
    else conn.on("open", () => conn.close());
  });
  peer.on("disconnected", () => {
    if (sitePeers.get(siteKey) === sp && !peer.destroyed) peer.reconnect();
  });
  peer.on("error", (e) => {
    if (sitePeers.get(siteKey) !== sp) return;
    if (e.type === "peer-unavailable") return; // une présence périmée : la personne est partie
    log(`PeerJS (${site}) : ${e.type}`);
    if (["network", "server-error", "socket-error", "browser-incompatible"].includes(e.type)) {
      sp.status = "error";
      update();
    }
  });
  return sp;
}

function releasePeer(siteKey, room) {
  const sp = sitePeers.get(siteKey);
  if (!sp) return;
  sp.rooms.delete(room);
  if (sp.rooms.size) return;
  sitePeers.delete(siteKey);
  setTimeout(() => sp.peer.destroy(), 300); // laisse partir les messages d'au revoir
}

// --- Ouverture et fermeture d'un salon --------------------------------------------------

// kind : "page" | "site"
function startRoom(key, kind, siteKey, site) {
  if (rooms.has(key)) return rooms.get(key);
  const room = {
    key,
    kind,
    siteKey,
    site,
    tag: "pagemates-" + key,
    sp: null,
    inst: null, // instance choisie (1, 2…), null tant qu'on ne sait pas qui est où
    picked: false,
    nostrKey: NostrTools.generateSecretKey(), // jetable : rien ne relie deux salons
    presenceTimer: null,
    sub: null,
    seen: new Map(), // clé de présence → { inst, peer, exp } : qui est dans quelle instance
    members: new Map(), // pubkey → membre
    pending: new Map(), // peerId → connexion en attente de poignée de main
    chat: [],
  };
  rooms.set(key, room);
  room.sp = acquirePeer(siteKey, site);
  room.sp.rooms.add(room);
  subscribePresence(room);
  setTimeout(() => pickInstance(room), PICK_WAIT);
  update();
  return room;
}

function endRoom(key) {
  const room = rooms.get(key);
  if (!room) return;
  rooms.delete(key);
  clearInterval(room.presenceTimer);
  room.sub?.close();
  if (room.inst && room.sp.id) publishPresence(room, true);
  for (const m of room.members.values()) safeSend(m.conn, { t: "bye" });
  for (const conn of room.pending.values()) conn.close();
  releasePeer(room.siteKey, room);
  if (room.kind === "page") for (const tab of tabsOnPage(key)) pushPeers(tab);
  update();
}

function roomStatus(room) {
  if (room.sp.status === "error") return "error";
  return room.sp.status === "open" && room.inst ? "open" : "connecting";
}

// --- Instances ---------------------------------------------------------------------

function purgeSeen(room) {
  const now = nowSeconds();
  for (const [k, v] of room.seen) if (v.exp < now) room.seen.delete(k);
}

// Nombre de personnes par instance (nous compris), d'après les présences
function instanceCounts(room) {
  purgeSeen(room);
  const mine = NostrTools.getPublicKey(room.nostrKey);
  const counts = new Map();
  for (const [k, v] of room.seen) if (k !== mine) counts.set(v.inst, (counts.get(v.inst) ?? 0) + 1);
  if (room.inst) counts.set(room.inst, (counts.get(room.inst) ?? 0) + 1);
  return counts;
}

// Première instance qui a de la place : les gens restent groupés autant que possible
function pickInstance(room, wanted = null) {
  if (rooms.get(room.key) !== room || (room.picked && !wanted)) return;
  room.picked = true;
  let inst = wanted;
  if (!inst) {
    const counts = instanceCounts(room);
    inst = 1;
    while ((counts.get(inst) ?? 0) >= INSTANCE_SIZE) inst++;
  }
  room.inst = inst;
  roomReady(room);
  update();
}

// PeerJS ouvert et instance choisie : on s'annonce et on appelle ceux qui sont déjà là
function roomReady(room) {
  if (!room.inst || !room.sp.id || room.presenceTimer) return;
  publishPresence(room);
  room.presenceTimer = setInterval(() => publishPresence(room), PRESENCE_EVERY);
  for (const v of room.seen.values()) discovered(room, v);
}

// Changement d'instance à la main ("new" = une instance vide de plus)
function switchInstance(room, inst) {
  const counts = instanceCounts(room);
  if (inst === "new") inst = Math.max(0, ...counts.keys()) + 1;
  inst = Math.floor(Number(inst));
  if (!(inst >= 1) || inst === room.inst) return null;
  if ((counts.get(inst) ?? 0) >= MAX_PEERS) return "errInstanceFull";
  for (const m of room.members.values()) safeSend(m.conn, { t: "bye" });
  for (const m of room.members.values()) m.conn.close();
  for (const conn of room.pending.values()) conn.close();
  room.members.clear();
  room.pending.clear();
  clearInterval(room.presenceTimer);
  room.presenceTimer = null;
  systemMessage(room.chat, "sysInstance", inst);
  pickInstance(room, inst);
  if (room.kind === "page") for (const tab of tabsOnPage(room.key)) pushPeers(tab);
  return null;
}

// --- Présence sur Nostr -------------------------------------------------------------

function publishPresence(room, leaving = false) {
  const created = nowSeconds();
  const event = NostrTools.finalizeEvent(
    {
      kind: 30078,
      created_at: created,
      tags: [["d", room.tag], ["t", room.tag], ["expiration", String(created + (leaving ? 30 : PRESENCE_TTL))]],
      content: JSON.stringify(leaving ? { v: 2, left: true } : { v: 2, peer: room.sp.id, inst: room.inst }),
    },
    room.nostrKey
  );
  Promise.allSettled(pool().publish(NOSTR_RELAYS, event)).then((results) => {
    if (!results.some((r) => r.status === "fulfilled")) log(t("logPresenceFailed"));
  });
}

function subscribePresence(room) {
  room.sub = pool().subscribeMany(NOSTR_RELAYS, [{ kinds: [30078], "#t": [room.tag], since: nowSeconds() - PRESENCE_TTL }], {
    onevent(e) {
      if (rooms.get(room.key) !== room) return;
      const expiration = Number(e.tags.find((tag) => tag[0] === "expiration")?.[1] ?? 0);
      if (expiration && expiration < nowSeconds()) return;
      const prev = room.seen.get(e.pubkey);
      if (prev && prev.at > e.created_at) return; // annonce plus ancienne que celle connue
      let c;
      try {
        c = JSON.parse(e.content);
      } catch {
        return;
      }
      if (c.left) {
        room.seen.delete(e.pubkey);
        return update();
      }
      const inst = Math.floor(Number(c.inst));
      if (typeof c.peer !== "string" || c.peer.length > 64 || !(inst >= 1 && inst < 10000)) return;
      const v = { peer: c.peer, inst, at: e.created_at, exp: expiration || e.created_at + PRESENCE_TTL };
      room.seen.set(e.pubkey, v);
      discovered(room, v);
      update();
    },
    // Les relais ont envoyé ce qu'ils savaient : inutile d'attendre plus pour choisir
    oneose() {
      pickInstance(room);
    },
  });
}

// Une personne s'est annoncée. Pour éviter les doubles connexions, c'est celui dont
// l'identifiant est le plus petit qui appelle ; l'autre attend l'appel.
function discovered(room, { peer: peerId, inst }) {
  const myId = room.sp.id;
  if (!myId || !room.presenceTimer || inst !== room.inst || peerId === myId || peerId > myId) return;
  if (room.pending.has(peerId) || [...room.members.values()].some((m) => m.conn.peer === peerId)) return;
  if (room.members.size + room.pending.size >= MAX_PEERS) return;
  setupConn(room, room.sp.peer.connect(peerId, { serialization: "json", reliable: true, metadata: { room: room.key } }));
}

// --- Connexions et poignée de main ----------------------------------------------------

function safeSend(conn, msg) {
  try {
    if (conn?.open) conn.send(msg);
  } catch {
    // connexion en train de tomber : le « close » suivra
  }
}

function setupConn(room, conn) {
  if (room.members.size + room.pending.size >= MAX_PEERS || !room.inst) {
    conn.on("open", () => conn.close());
    return;
  }
  room.pending.set(conn.peer, conn);
  const timeout = setTimeout(() => {
    if (room.pending.get(conn.peer) === conn) conn.close();
  }, 15000);

  conn.on("open", () => {
    const ev = NostrTools.finalizeEvent(
      {
        kind: HELLO_KIND,
        created_at: nowSeconds(),
        tags: [["from", room.sp.id], ["to", conn.peer], ["room", room.key], ["inst", String(room.inst)]],
        content: "",
      },
      identity.secret
    );
    safeSend(conn, { t: "hello", ev, name: settings.name, color: settings.color });
  });
  conn.on("data", (msg) => {
    clearTimeout(timeout);
    onData(room, conn, msg);
  });
  conn.on("close", () => dropConn(room, conn));
  conn.on("error", () => dropConn(room, conn));
}

function dropConn(room, conn) {
  if (room.pending.get(conn.peer) === conn) room.pending.delete(conn.peer);
  for (const m of room.members.values()) {
    if (m.conn !== conn) continue;
    room.members.delete(m.id);
    if (rooms.get(room.key) !== room) return;
    systemMessage(room.chat, room.kind === "page" ? "sysLeftPage" : "sysLeftSite", m.name);
    roomChanged(room);
  }
}

function verifyHello(room, conn, msg) {
  const ev = msg?.ev;
  if (!ev || typeof ev !== "object" || ev.kind !== HELLO_KIND) return null;
  try {
    if (!NostrTools.verifyEvent(ev)) return null;
  } catch {
    return null; // événement mal formé
  }
  const tag = (k) => ev.tags.find((x) => x[0] === k)?.[1];
  if (tag("from") !== conn.peer || tag("to") !== room.sp.id || tag("room") !== room.key) return null;
  if (tag("inst") !== String(room.inst)) return null;
  if (Math.abs(nowSeconds() - ev.created_at) > 300) return null;
  return ev.pubkey;
}

function cleanName(name) {
  return String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 24) || "?";
}

function cleanColor(color) {
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : "#888888";
}

function onData(room, conn, msg) {
  if (rooms.get(room.key) !== room || !msg || typeof msg !== "object") return;

  if (msg.t === "hello" && room.pending.get(conn.peer) === conn) {
    const id = verifyHello(room, conn, msg);
    if (!id || id === identity.pubkey || settings.blocked[id]) return conn.close();
    room.pending.delete(conn.peer);
    // Déjà connecté à cette personne (reconnexion) : la nouvelle connexion remplace l'ancienne
    const old = room.members.get(id);
    if (old) old.conn.close();
    const m = {
      id,
      conn,
      name: cleanName(msg.name),
      color: cleanColor(msg.color),
      chatTimes: [],
      liveTimes: [],
      metaTimes: [],
      drops: [],
      mutedUntil: 0,
    };
    room.members.set(id, m);
    if (!old) systemMessage(room.chat, room.kind === "page" ? "sysJoinedPage" : "sysJoinedSite", m.name);
    knownPeople.set(id, { name: m.name, color: m.color });
    roomChanged(room);
    return;
  }

  const m = [...room.members.values()].find((x) => x.conn === conn);
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
  if (!ok) return flooded(room, m, now);

  switch (msg.t) {
    case "profile": {
      const name = cleanName(msg.name);
      const color = cleanColor(msg.color);
      if (name !== m.name) systemMessage(room.chat, "sysRenamed", m.name, name);
      Object.assign(m, { name, color });
      knownPeople.set(m.id, { name, color });
      roomChanged(room);
      break;
    }
    case "chat": {
      const text = String(msg.text ?? "").slice(0, TEXT_MAX).trim();
      if (!text) return;
      addChat(room.chat, { from: m.id, name: m.name, color: m.color, text });
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
      if (room.kind !== "page") return;
      const payload = msg.t === "sel" ? (msg.q == null ? null : cleanQuote(msg.q)) : msg.a == null ? null : cleanAnchor(msg.a);
      if (payload === undefined || (msg.t === "click" && !payload)) return;
      for (const tab of tabsOnPage(room.key)) {
        tab.port.postMessage(msg.t === "sel" ? { t: "sel", id: m.id, q: payload } : { t: msg.t, id: m.id, a: payload });
      }
      break;
    }
    case "bye":
      conn.close();
      break;
  }
}

function flooded(room, m, now) {
  m.drops.push(now);
  while (m.drops.length && now - m.drops[0] > 10000) m.drops.shift();
  if (m.drops.length < FLOOD_DROPS) return;
  m.drops = [];
  m.mutedUntil = now + FLOOD_MUTE;
  systemMessage(room.chat, "sysFlood", m.name);
  update();
}

// Membres changés : pages concernées (curseurs, badge) et barre latérale
function roomChanged(room) {
  if (room.kind === "page") for (const tab of tabsOnPage(room.key)) pushPeers(tab);
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

// Envoi depuis la barre latérale, dans le salon de page ou de site de l'onglet
function sendChat(tab, kind, text) {
  const room = rooms.get(kind === "page" ? tab?.pageKey : tab?.siteKey);
  if (!room || roomStatus(room) !== "open") return "errNotConnected";
  text = String(text ?? "").slice(0, TEXT_MAX).trim();
  if (!text) return null;
  if (!rateOk(sendTimes, settings.sendRate)) return "errTooFast";
  for (const m of room.members.values()) safeSend(m.conn, { t: "chat", text });
  addChat(room.chat, { from: "me", name: settings.name, color: settings.color, text });
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

// Une personne peut être jointe en MP tant qu'on partage un salon avec elle
function memberAnywhere(id) {
  for (const room of rooms.values()) {
    const m = room.members.get(id);
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
  const room = rooms.get(tab.pageKey);
  if (!room) return;
  if (msg.t === "sel" ? !settings.shareSelection : !settings.shareCursor) return;
  if (!rateOk(tab.liveTimes, LIVE_PER_SECOND / 2)) return;
  const payload = msg.t === "sel" ? (msg.q == null ? null : cleanQuote(msg.q)) : msg.a == null ? null : cleanAnchor(msg.a);
  if (payload === undefined) return;
  const out = msg.t === "sel" ? { t: "sel", q: payload } : { t: msg.t, a: payload };
  for (const m of room.members.values()) safeSend(m.conn, out);
}

// --- Diffusion de nos changements --------------------------------------------------

function broadcastProfile() {
  for (const room of rooms.values()) {
    for (const m of room.members.values()) safeSend(m.conn, { t: "profile", name: settings.name, color: settings.color });
  }
}

function block(id) {
  const name = knownPeople.get(id)?.name ?? "?";
  settings.blocked[id] = name;
  saveSettings();
  for (const room of rooms.values()) room.members.get(id)?.conn.close();
  dms.delete(id);
  update();
}
