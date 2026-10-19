// Moteur de l'extension : réglages, suivi des onglets, lien avec la barre latérale.
// Les salons eux-mêmes (réseau, instances, chat, MP) sont dans rooms.js, chargé avant ce fichier.
// Rien ici ne doit appeler rooms.js avant la fin du chargement : tout passe par init().

const PALETTE = ["#e5484d", "#f76b15", "#ffb224", "#46a758", "#12a594", "#0090ff", "#3e63dd", "#8e4ec6", "#d6409f", "#978365"];

const DEFAULTS = {
  name: "",
  color: "",
  lang: "auto",
  view: "both", // "both" | "page" | "site" : salons affichés dans la barre latérale
  showCursors: true,
  shareCursor: true,
  shareSelection: true,
  connected: true, // interrupteur général
  autoJoin: false, // rejoindre tous les sites sans demander
  sites: {}, // site → true (toujours rejoindre) | false (jamais)
  blocked: {}, // pubkey → dernier nom connu
};

let settings = { ...DEFAULTS };
let identity = { secret: null, pubkey: "", pow: null };
let mining = null; // { tries } pendant le calcul de la preuve de travail
const sendTimes = [];

// tabId → { id, windowId, port, url, site, siteKey, pageKey, incognito, liveTimes, lastPeers }
const tabs = new Map();
// windowId → tabId de l'onglet actif
const activeTab = new Map();
const sidebars = new Set(); // { port, windowId }
const logLines = [];

function log(line) {
  logLines.push(`${new Date().toLocaleTimeString()} ${line}`);
  if (logLines.length > 50) logLines.shift();
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));

async function sha(text) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).slice(0, 32);
}

// --- Adresses ------------------------------------------------------------------------

// Paramètres de pistage : retirés pour que deux personnes sur la même page tombent dans
// le même salon, même arrivées par des liens différents
const TRACKING = /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|yclid|_ga|_gl|ref|ref_src|si|spm|feature)$/i;
const PRIVATE_HOST = /^(localhost|\d+\.\d+\.\d+\.\d+|\[.*\])(:\d+)?$|\.(local|lan|home|internal|localhost)(:\d+)?$/i;

function normalize(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const site = u.host.toLowerCase().replace(/^www\./, "");
  const params = [...u.searchParams].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length ? "?" + new URLSearchParams(params) : "";
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return { site, page: site + path + query };
}

function siteEnabled(site) {
  if (!settings.connected || !site) return false;
  if (settings.sites[site] !== undefined) return settings.sites[site];
  return settings.autoJoin && !PRIVATE_HOST.test(site);
}

function tabsOnPage(pageKey) {
  return [...tabs.values()].filter((tab) => tab.pageKey === pageKey && rooms.has(pageKey));
}

// --- Salons voulus ↔ salons ouverts --------------------------------------------------

const GRACE = 8000; // un rechargement de page ne doit pas faire quitter le salon
const closing = new Map(); // roomKey → timer
// Page quittée pour une autre (lien suivi, navigation dans le site) : pas de délai de
// grâce, sinon on resterait affiché « sur la page » chez les autres
const leftPages = new Set();
const lastPageOfTab = new Map(); // tabId → pageKey, gardé après la fermeture du port

// Salons que les onglets ouverts demandent : roomKey → { kind, siteKey, site }
function wantedRooms() {
  const wanted = new Map();
  for (const tab of tabs.values()) {
    if (!tab.siteKey || tab.incognito || !siteEnabled(tab.site)) continue;
    wanted.set(tab.pageKey, { kind: "page", siteKey: tab.siteKey, site: tab.site });
    if (settings.view !== "page") wanted.set(tab.siteKey, { kind: "site", siteKey: tab.siteKey, site: tab.site });
  }
  return wanted;
}

function reconcile() {
  // Sans preuve de travail, personne n'accepterait nos poignées de main : on attend
  const wanted = identity.pow == null ? new Map() : wantedRooms();
  for (const [key, { kind, siteKey, site }] of wanted) {
    clearTimeout(closing.get(key));
    closing.delete(key);
    if (!rooms.has(key)) startRoom(key, kind, siteKey, site);
  }
  for (const [key, room] of rooms) {
    if (wanted.has(key)) continue;
    // Site désactivé à la main ou page quittée : on part tout de suite ; onglets fermés
    // (ou rechargés) : on attend un peu
    const immediate =
      !settings.connected || !siteEnabled(room.site) || (room.kind === "site" && settings.view === "page") || leftPages.has(key);
    if (immediate) {
      clearTimeout(closing.get(key));
      closing.delete(key);
      endRoom(key);
    } else if (!closing.has(key))
      closing.set(
        key,
        setTimeout(() => {
          closing.delete(key);
          if (!wantedRooms().has(key)) endRoom(key);
        }, GRACE)
      );
  }
  leftPages.clear();
  for (const tab of tabs.values()) pushPeers(tab);
  update();
}

// --- Pages (scripts injectés) ----------------------------------------------------------

function contentConfig() {
  const { showCursors, shareCursor, shareSelection } = settings;
  return { t: "config", config: { showCursors, shareCursor, shareSelection } };
}

function connectPage(port) {
  const t0 = port.sender.tab;
  if (!t0) return;
  const tab = {
    id: t0.id,
    windowId: t0.windowId,
    port,
    url: "",
    site: "",
    siteKey: "",
    pageKey: "",
    incognito: t0.incognito,
    liveTimes: [],
    lastPeers: "",
  };
  port.postMessage(contentConfig());
  port.onMessage.addListener(async (msg) => {
    if (msg.t === "url") {
      tab.url = msg.url;
      const n = normalize(msg.url);
      const keys = n ? await Promise.all([sha("site:" + n.site), sha("page:" + n.page)]) : ["", ""];
      if (tab.url !== msg.url) return; // l'adresse a encore changé entre-temps
      const previous = lastPageOfTab.get(tab.id);
      if (previous && previous !== keys[1]) leftPages.add(previous);
      Object.assign(tab, { site: n?.site ?? "", siteKey: keys[0], pageKey: keys[1], lastPeers: "" });
      tabs.set(tab.id, tab);
      lastPageOfTab.set(tab.id, tab.pageKey);
      reconcile();
    } else if (msg.t === "cur" || msg.t === "click" || msg.t === "sel") {
      if (tabs.get(tab.id) === tab) relayLive(tab, msg);
    }
  });
  port.onDisconnect.addListener(() => {
    if (tabs.get(tab.id) !== tab) return;
    tabs.delete(tab.id);
    reconcile();
  });
}

// Personnes présentes sur la page de cet onglet → script de la page et badge du bouton
function pushPeers(tab) {
  const room = rooms.get(tab.pageKey);
  const list = room ? [...room.members.values()].map(({ id, name, color }) => ({ id, name, color })) : [];
  const json = JSON.stringify(list);
  if (json === tab.lastPeers) return;
  tab.lastPeers = json;
  tab.port.postMessage({ t: "peers", list });
  browser.browserAction.setBadgeText({ tabId: tab.id, text: list.length ? String(list.length) : "" }).catch(() => {});
}

// --- Barre latérale ------------------------------------------------------------------

let updateTimer = null;
function update() {
  if (updateTimer) return;
  updateTimer = setTimeout(() => {
    updateTimer = null;
    for (const sb of sidebars) sb.port.postMessage({ t: "snap", snap: snapshot(sb.windowId) });
  }, 50);
}

function roomInfo(room, here = null) {
  if (!room) return null;
  const now = Date.now();
  return {
    status: roomStatus(room),
    inst: room.inst,
    instances: [...instanceCounts(room)].sort(([a], [b]) => a - b).map(([n, count]) => ({ n, count })),
    people: [...room.members.values()].map((m) => ({
      id: m.id,
      name: m.name,
      color: m.color,
      here: here ? here.members.has(m.id) : true,
      muted: m.mutedUntil > now,
    })),
    chat: room.chat.filter((m) => !settings.blocked[m.from]), // ce qu'une personne bloquée a écrit disparaît aussi
  };
}

function snapshot(windowId) {
  const tab = tabs.get(activeTab.get(windowId));
  const pageRoom = tab && rooms.get(tab.pageKey);
  return {
    settings,
    palette: PALETTE,
    me: identity.pubkey,
    instanceSize: INSTANCE_SIZE,
    sendRate: SEND_PER_SECOND,
    mining: mining && { tries: mining.tries, expected: 2 ** POW_BITS },
    ctx: tab?.site ? { site: tab.site, enabled: siteEnabled(tab.site), incognito: tab.incognito } : null,
    page: roomInfo(pageRoom),
    site: roomInfo(tab && rooms.get(tab.siteKey), pageRoom ?? { members: new Map() }),
    dms: [...dms].map(([id, th]) => ({
      id,
      name: knownPeople.get(id)?.name ?? "?",
      color: knownPeople.get(id)?.color ?? "#888888",
      online: !!memberAnywhere(id),
      unread: th.unread,
      msgs: th.msgs,
    })),
    log: logLines,
  };
}

function cleanSettings(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS) || k === "blocked") continue;
    if (k === "name") out.name = cleanName(v);
    else if (k === "color") out.color = cleanColor(v);
    else if (k === "view") out.view = ["both", "page", "site"].includes(v) ? v : "both";
    else if (k === "lang") out.lang = ["auto", "fr", "en"].includes(v) ? v : "auto";
    else if (k === "sites") out.sites = v && typeof v === "object" ? v : {};
    else out[k] = !!v;
  }
  return out;
}

function saveSettings() {
  browser.storage.local.set({ settings });
}

const commands = {
  setSettings(patch) {
    const before = settings;
    settings = { ...settings, ...cleanSettings(patch) };
    saveSettings();
    setLang(settings.lang);
    if (settings.name !== before.name || settings.color !== before.color) broadcastProfile();
    if (["showCursors", "shareCursor", "shareSelection"].some((k) => settings[k] !== before[k])) {
      for (const tab of tabs.values()) tab.port.postMessage(contentConfig());
    }
    reconcile();
  },
  // Rejoindre ou quitter le salon d'un site (retenu pour la prochaine fois)
  setSite(site, on) {
    settings.sites = { ...settings.sites, [site]: !!on };
    if (on) settings.connected = true;
    saveSettings();
    reconcile();
  },
  forgetSite(site) {
    const { [site]: _, ...rest } = settings.sites;
    settings.sites = rest;
    saveSettings();
    reconcile();
  },
  chat(windowId, kind, text) {
    return sendChat(tabs.get(activeTab.get(windowId)), kind, text);
  },
  // Passer dans une autre instance du salon de page ou de site (n, ou "new")
  setInstance(windowId, kind, n) {
    const tab = tabs.get(activeTab.get(windowId));
    const room = rooms.get(kind === "page" ? tab?.pageKey : tab?.siteKey);
    return room ? switchInstance(room, n) : "errNotConnected";
  },
  dm(id, text) {
    return sendDm(id, text);
  },
  readDm(id) {
    const th = dms.get(id);
    if (th?.unread) {
      th.unread = 0;
      update();
    }
  },
  // Ouvre une conversation (vide) avec quelqu'un
  openDm(id) {
    dmThread(id);
    update();
  },
  block(id) {
    block(id);
  },
  unblock(id) {
    const { [id]: _, ...rest } = settings.blocked;
    settings.blocked = rest;
    saveSettings();
    update();
  },
};

function connectSidebar(port) {
  const sb = { port, windowId: null };
  port.onMessage.addListener(async ({ cmd, args = [], req }) => {
    await ready;
    if (cmd === "hello") {
      sb.windowId = args[0];
      sidebars.add(sb);
      if (!activeTab.has(sb.windowId)) {
        const [tab] = await browser.tabs.query({ active: true, windowId: sb.windowId });
        if (tab) activeTab.set(sb.windowId, tab.id);
      }
      port.postMessage({ t: "snap", snap: snapshot(sb.windowId) });
      return;
    }
    const error = commands[cmd]?.(...args) ?? null;
    if (req) port.postMessage({ t: "reply", req, error });
  });
  port.onDisconnect.addListener(() => sidebars.delete(sb));
}

// --- Démarrage ---------------------------------------------------------------------

browser.runtime.onConnect.addListener((port) => {
  if (port.name === "page") ready.then(() => connectPage(port));
  else if (port.name === "sidebar") connectSidebar(port);
});

browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
  activeTab.set(windowId, tabId);
  update();
});
browser.tabs.onAttached.addListener((tabId, { newWindowId }) => {
  const tab = tabs.get(tabId);
  if (tab) tab.windowId = newWindowId;
});
browser.tabs.onRemoved.addListener((tabId) => lastPageOfTab.delete(tabId)); // plus de navigation à suivre
browser.windows.onRemoved.addListener((windowId) => activeTab.delete(windowId));

browser.browserAction.onClicked.addListener(() => browser.sidebarAction.toggle());
browser.browserAction.setBadgeBackgroundColor({ color: "#0090ff" });

// À l'installation, les pages déjà ouvertes n'ont pas le script : on l'injecte
browser.runtime.onInstalled.addListener(async () => {
  for (const tab of await browser.tabs.query({ url: ["http://*/*", "https://*/*"] })) {
    browser.tabs.executeScript(tab.id, { file: "content.js" }).catch(() => {});
  }
});

// Preuve de travail de notre identité : une seule fois, puis gardée avec la clé
function mineIdentity() {
  mining = { tries: 0 };
  const worker = new Worker("pow-worker.js");
  worker.onmessage = ({ data }) => {
    if (data.t === "progress") {
      mining.tries = data.tries;
      return update();
    }
    worker.terminate();
    mining = null;
    identity.pow = data.nonce;
    browser.storage.local.set({ pow: { pubkey: identity.pubkey, nonce: data.nonce } });
    log(t("logPowDone"));
    reconcile();
  };
  worker.postMessage({ t: "mine", pubkey: identity.pubkey, bits: POW_BITS });
  update();
}

async function init() {
  const stored = await browser.storage.local.get(["settings", "identity", "pow"]);
  settings = { ...DEFAULTS, ...stored.settings };
  // Anciens réglages d'anti-flood (0.1 à 0.3) : les limites sont désormais fixes
  delete settings.sendRate;
  delete settings.recvRate;
  if (!settings.name) settings.name = `${t("defaultName")}-${Math.floor(1000 + Math.random() * 9000)}`;
  if (!settings.color) settings.color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  setLang(settings.lang);
  let secret = typeof stored.identity === "string" && /^[0-9a-f]{64}$/.test(stored.identity) ? stored.identity : null;
  if (!secret) secret = hex(NostrTools.generateSecretKey());
  identity = { secret: unhex(secret), pubkey: NostrTools.getPublicKey(unhex(secret)), pow: null };
  if (stored.pow?.pubkey === identity.pubkey && Number.isSafeInteger(stored.pow.nonce)) identity.pow = stored.pow.nonce;
  await browser.storage.local.set({ settings, identity: secret });
  if (identity.pow == null) mineIdentity();
  for (const tab of await browser.tabs.query({ active: true })) activeTab.set(tab.windowId, tab.id);
}

const ready = init();
