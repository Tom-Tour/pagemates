// Moteur de l'extension : réglages, suivi des onglets, lien avec la barre latérale.
// Les salons eux-mêmes (réseau, chat, MP) sont dans rooms.js, chargé avant ce fichier.
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
  sendRate: 2, // messages envoyés par seconde, au plus
  recvRate: 3, // messages reçus par seconde et par personne, au plus
  blocked: {}, // pubkey → dernier nom connu
};

let settings = { ...DEFAULTS };
let identity = { secret: null, pubkey: "" };
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

function tabsOnSite(siteKey) {
  return [...tabs.values()].filter((tab) => tab.siteKey === siteKey);
}

function tabsOnPage(pageKey) {
  return [...tabs.values()].filter((tab) => tab.pageKey === pageKey && sessions.has(tab.siteKey));
}

function pagesOnSite(siteKey) {
  return [...new Set(tabsOnSite(siteKey).map((tab) => tab.pageKey))].sort();
}

// --- Salons voulus ↔ salons ouverts --------------------------------------------------

const GRACE = 8000; // un rechargement de page ne doit pas faire quitter le salon
const closing = new Map(); // siteKey → timer

function reconcile() {
  const wanted = new Map();
  for (const tab of tabs.values()) {
    if (tab.siteKey && !tab.incognito && siteEnabled(tab.site)) wanted.set(tab.siteKey, tab.site);
  }
  for (const [key, site] of wanted) {
    clearTimeout(closing.get(key));
    closing.delete(key);
    if (!sessions.has(key)) startSession(key, site);
  }
  for (const key of sessions.keys()) {
    if (wanted.has(key) || closing.has(key)) continue;
    // Site désactivé à la main : on part tout de suite ; onglets fermés : on attend un peu
    const immediate = !settings.connected || !siteEnabled(sessions.get(key).site);
    if (immediate) endSession(key);
    else
      closing.set(
        key,
        setTimeout(() => {
          closing.delete(key);
          if (![...tabs.values()].some((tab) => tab.siteKey === key && siteEnabled(tab.site))) endSession(key);
        }, GRACE)
      );
  }
  for (const key of sessions.keys()) broadcastPages(key);
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
      Object.assign(tab, { site: n?.site ?? "", siteKey: keys[0], pageKey: keys[1], lastPeers: "" });
      tabs.set(tab.id, tab);
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
  const s = sessions.get(tab.siteKey);
  const list = s ? peopleOnPage(s, tab.pageKey).map(({ id, name, color }) => ({ id, name, color })) : [];
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

function snapshot(windowId) {
  const tab = tabs.get(activeTab.get(windowId));
  const s = tab && sessions.get(tab.siteKey);
  const now = Date.now();
  return {
    settings,
    palette: PALETTE,
    me: identity.pubkey,
    ctx: tab?.site
      ? { site: tab.site, enabled: siteEnabled(tab.site), incognito: tab.incognito, status: s?.status ?? "off" }
      : null,
    people: s
      ? [...s.members.values()].map((m) => ({
          id: m.id,
          name: m.name,
          color: m.color,
          here: m.pages.has(tab.pageKey),
          muted: m.mutedUntil > now,
        }))
      : [],
    siteChat: s?.chat ?? [],
    pageChat: s?.pageChats.get(tab.pageKey) ?? [],
    dms: [...dms].map(([id, th]) => ({
      id,
      name: knownPeople.get(id)?.name ?? "?",
      color: knownPeople.get(id)?.color ?? "#888888",
      online: !!memberAnywhere(id),
      unread: th.unread,
      msgs: th.msgs,
    })),
    sites: sessions.size,
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
    else if (k === "sendRate" || k === "recvRate") out[k] = Math.min(20, Math.max(1, Math.round(Number(v)) || 1));
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
  chat(windowId, scope, text) {
    return sendChat(tabs.get(activeTab.get(windowId)), scope, text);
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
browser.windows.onRemoved.addListener((windowId) => activeTab.delete(windowId));

browser.browserAction.onClicked.addListener(() => browser.sidebarAction.toggle());
browser.browserAction.setBadgeBackgroundColor({ color: "#0090ff" });

// À l'installation, les pages déjà ouvertes n'ont pas le script : on l'injecte
browser.runtime.onInstalled.addListener(async () => {
  for (const tab of await browser.tabs.query({ url: ["http://*/*", "https://*/*"] })) {
    browser.tabs.executeScript(tab.id, { file: "content.js" }).catch(() => {});
  }
});

async function init() {
  const stored = await browser.storage.local.get(["settings", "identity"]);
  settings = { ...DEFAULTS, ...stored.settings };
  if (!settings.name) settings.name = `${t("defaultName")}-${Math.floor(1000 + Math.random() * 9000)}`;
  if (!settings.color) settings.color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  setLang(settings.lang);
  let secret = typeof stored.identity === "string" && /^[0-9a-f]{64}$/.test(stored.identity) ? stored.identity : null;
  if (!secret) secret = hex(NostrTools.generateSecretKey());
  identity = { secret: unhex(secret), pubkey: NostrTools.getPublicKey(unhex(secret)) };
  await browser.storage.local.set({ settings, identity: secret });
  for (const tab of await browser.tabs.query({ active: true })) activeTab.set(tab.windowId, tab.id);
}

const ready = init();
