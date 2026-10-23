// Moteur de l'extension : réglages, suivi des onglets, lien avec la barre latérale.
// Les salons eux-mêmes (réseau, instances, chat, MP) sont dans rooms.js, chargé avant ce fichier.
// Rien ici ne doit appeler rooms.js avant la fin du chargement : tout passe par init().

const DEFAULTS = {
  name: "",
  nameSet: false, // pseudo choisi ou accepté (sinon proposé au début de la première conversation)
  color: "",
  lang: "auto",
  view: "both", // "both" | "page" | "site" : salons affichés dans la barre latérale
  showCursors: true,
  shareCursor: true,
  shareSelection: true,
  chatSound: false, // petit son à chaque nouveau message (salons et messages privés)
  connected: true, // interrupteur général
  autoJoin: true, // rejoindre tous les sites sans demander (sauf navigation privée et adresses locales)
  sites: {}, // site → true (toujours rejoindre) | false (jamais)
  blocked: {}, // pubkey → dernier nom connu
  pageRules: {}, // site → { depth, params: { nom: true | false } } : ce qui définit le salon de page
  hiddenInk: {}, // pubkey → true : personnes dont on masque les dessins
};

let settings = { ...DEFAULTS };
const sendTimes = [];

// tabId → { id, windowId, port, url, site, siteKey, pageKey, incognito, liveTimes, lastPeers }
const tabs = new Map();
// windowId → tabId de l'onglet actif
const activeTab = new Map();
const sidebars = new Set(); // { port, windowId }
const journal = createLog();

function log(line) {
  journal.add(line);
}

async function sha(text) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).slice(0, 32);
}

// --- Adresses ------------------------------------------------------------------------

// Ce qui définit le salon d'une page : le site, le chemin et les paramètres retenus.
// Chacun peut, depuis la barre latérale, inclure ou exclure un paramètre, ou couper le
// chemin (un salon par section : reddit.com/r/france). Choix retenus par site, sans règle
// propre à tel ou tel site : deux personnes se retrouvent dès qu'elles obtiennent la
// même adresse.
//
// Paramètres exclus par défaut, parce qu'ils ne changent pas ce qu'on regarde : pistage,
// position dans une vidéo, contexte d'arrivée (playlist…). Deux personnes arrivées par
// des liens différents tombent ainsi dans le même salon.
const IGNORED_PARAMS =
  /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|yclid|_ga|_gl|ref|ref_src|si|spm|feature|t|start|list|index|start_radio|pp|ab_channel)$/i;
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
  const rule = settings.pageRules[site] ?? {};
  const segments = u.pathname.split("/").filter(Boolean);
  const depth = Number.isInteger(rule.depth) && rule.depth >= 1 && rule.depth < segments.length ? rule.depth : null;
  const params = [...u.searchParams].map(([name, value]) => ({ name, value, on: rule.params?.[name] ?? !IGNORED_PARAMS.test(name) }));
  const kept = params.filter((p) => p.on).map((p) => [p.name, p.value]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = kept.length ? "?" + new URLSearchParams(kept) : "";
  const path = "/" + segments.slice(0, depth ?? segments.length).join("/");
  return { site, page: site + path + query, parts: { segments, depth, params, custom: !!settings.pageRules[site] } };
}

function siteEnabled(site) {
  if (!settings.connected || !site) return false;
  if (settings.sites[site] !== undefined) return settings.sites[site];
  return settings.autoJoin && !PRIVATE_HOST.test(site);
}

function tabsOnPage(pageKey) {
  return [...tabs.values()].filter((tab) => tab.pageKey === pageKey && rooms.has(pageKey));
}

// --- Nos dessins ------------------------------------------------------------------------

// pageKey → Map(id → { id, a, pts }) : gardés d'une session à l'autre, renvoyés à qui
// arrive sur la page. Les pages les plus anciennement dessinées sont oubliées en premier.
let myInk = new Map();
const INK_PAGES = 200;
const INK_STROKES = 300; // par page
const INK_POINTS = 30000; // par page
let inkSaveTimer = null;

function inkFor(pageKey) {
  return [...(myInk.get(pageKey)?.values() ?? [])].map(({ id, a, pts }) => ({ id, a, pts }));
}

function saveInk() {
  clearTimeout(inkSaveTimer);
  inkSaveTimer = setTimeout(() => {
    browser.storage.local.set({ ink: Object.fromEntries([...myInk].map(([k, m]) => [k, [...m.values()]])) });
  }, 1000);
}

// Début (avec ancrage) ou suite d'un de nos traits → false si refusé
function recordInk(pageKey, stroke) {
  let page = myInk.get(pageKey);
  if (page) myInk.delete(pageKey); // remise en fin de liste : page dessinée récemment
  else page = new Map();
  myInk.set(pageKey, page);
  while (myInk.size > INK_PAGES) myInk.delete(myInk.keys().next().value);
  const old = page.get(stroke.id);
  if (old) {
    if (old.pts.length + stroke.pts.length > 2000) return false;
    old.pts.push(...stroke.pts);
  } else {
    if (!stroke.a) return false;
    page.set(stroke.id, { id: stroke.id, a: stroke.a, pts: stroke.pts });
  }
  // Trop de dessins sur la page : les plus anciens traits partent
  let points = 0;
  for (const st of page.values()) points += st.pts.length;
  while (page.size > INK_STROKES || points > INK_POINTS) {
    const first = page.values().next().value;
    points -= first.pts.length;
    page.delete(first.id);
  }
  saveInk();
  if (!old) update(); // nouveau trait : le nombre de dessins change dans la barre latérale
  return true;
}

// id null = tous nos dessins de la page
function removeInk(pageKey, id) {
  const page = myInk.get(pageKey);
  if (!page) return;
  if (id == null) page.clear();
  else page.delete(id);
  if (!page.size) myInk.delete(pageKey);
  saveInk();
  update();
}

// Nos dessins de la page de cet onglet → script de la page (seulement si le site est rejoint)
function pushMine(tab) {
  const on = siteEnabled(tab.site) && !tab.incognito;
  const key = `${tab.pageKey}|${on}`;
  if (key === tab.lastMine) return;
  tab.lastMine = key;
  tab.port.postMessage({ t: "mine", list: on ? inkFor(tab.pageKey) : [] });
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
  for (const tab of tabs.values()) {
    pushPeers(tab);
    pushMine(tab);
    // Plus de salon de page : plus de mode dessin
    if (tab.drawMode && !rooms.has(tab.pageKey)) setDrawMode(tab, false);
  }
  update();
}

// --- Pages (scripts injectés) ----------------------------------------------------------

function contentConfig() {
  const { showCursors, shareCursor, shareSelection, color } = settings;
  return { t: "config", config: { showCursors, shareCursor, shareSelection, color } };
}

function setDrawMode(tab, on) {
  tab.drawMode = on;
  tab.port.postMessage({ t: "drawMode", on, hint: t("drawHint") });
  update();
}

function connectPage(port, early = []) {
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
  const onMessage = (msg) => {
    if (msg.t === "url") applyUrl(tab, msg.url);
    else if (msg.t === "drawMode") {
      // Échap dans la page
      tab.drawMode = false;
      update();
    } else if (msg.t === "draw" || msg.t === "undraw") {
      if (tabs.get(tab.id) === tab) relayLive(tab, msg);
    } else if (msg.t === "cur" || msg.t === "click" || msg.t === "sel") {
      if (tabs.get(tab.id) === tab) relayLive(tab, msg);
    }
  };
  port.onMessage.addListener(onMessage);
  for (const msg of early) onMessage(msg);
  port.onDisconnect.addListener(() => {
    if (tabs.get(tab.id) !== tab) return;
    tabs.delete(tab.id);
    reconcile();
  });
}

// Adresse d'un onglet → ses salons (aussi rappelé quand on change ce qui définit la page)
async function applyUrl(tab, url) {
  tab.url = url;
  const n = normalize(url);
  const keys = n ? await Promise.all([sha("site:" + n.site), sha("page:" + n.page)]) : ["", ""];
  if (tab.url !== url) return; // l'adresse a encore changé entre-temps
  const previous = lastPageOfTab.get(tab.id);
  if (previous && previous !== keys[1]) leftPages.add(previous);
  if (tab.drawMode && previous !== keys[1]) setDrawMode(tab, false);
  Object.assign(tab, { site: n?.site ?? "", siteKey: keys[0], pageKey: keys[1], parts: n?.parts ?? null, lastPeers: "", lastMine: "" });
  tabs.set(tab.id, tab);
  lastPageOfTab.set(tab.id, tab.pageKey);
  reconcile();
}

function setPageRule(site, change) {
  if (typeof site !== "string" || !site) return;
  const rule = { params: {}, ...settings.pageRules[site] };
  change(rule);
  const empty = rule.depth == null && !Object.keys(rule.params).length;
  const { [site]: _, ...rest } = settings.pageRules;
  settings.pageRules = empty ? rest : { ...rest, [site]: rule };
  saveSettings();
  for (const tab of tabs.values()) if (tab.site === site) applyUrl(tab, tab.url);
}

// Personnes présentes sur la page de cet onglet → script de la page et badge du bouton
function pushPeers(tab) {
  const room = rooms.get(tab.pageKey);
  const list = room ? [...room.members.values()].map(({ id, name, color }) => ({ id, name, color, ink: !settings.hiddenInk[id] })) : [];
  const json = JSON.stringify(list);
  if (json === tab.lastPeers) return;
  tab.lastPeers = json;
  tab.port.postMessage({ t: "peers", list });
  tab.here = list.length;
  pushBadge(tab);
}

// Badge du bouton : messages privés non lus en priorité (en rouge), sinon personnes sur la page
function pushBadge(tab) {
  const unread = unreadDms();
  const text = unread ? "✉" + unread : tab.here ? String(tab.here) : "";
  const key = `${text}|${!!unread}`;
  if (key === tab.lastBadge) return;
  tab.lastBadge = key;
  browser.browserAction.setBadgeText({ tabId: tab.id, text }).catch(() => {});
  browser.browserAction.setBadgeBackgroundColor({ tabId: tab.id, color: unread ? BADGE_COLORS.PRIVATE : BADGE_COLORS.COUNT }).catch(() => {});
}

function unreadDms() {
  let n = 0;
  for (const th of dms.values()) n += th.unread;
  return n;
}

// Message privé reçu : badge partout, et une notification si aucune barre latérale n'est
// ouverte (sans le texte du message, qui pourrait s'afficher devant d'autres personnes)
const notified = new Map(); // pubkey → dernière notification
function dmReceived(m) {
  for (const tab of tabs.values()) pushBadge(tab);
  if (sidebars.size || Date.now() - (notified.get(m.id) ?? 0) < 60000) return;
  notified.set(m.id, Date.now());
  browser.notifications
    .create("dm-" + m.id, { type: "basic", iconUrl: "icons/icon-96.png", title: "Pagemates", message: t("notifyDm", `${m.name} · ${m.code}`) })
    .catch(() => {});
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
      code: m.code,
      here: here ? here.members.has(m.id) : true,
      muted: m.mutedUntil > now,
      inkHidden: !!settings.hiddenInk[m.id],
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
    myCode: identity.code,
    instanceSize: INSTANCE_SIZE,
    sendRate: LIMITS.SEND_PER_SECOND,
    mining: myIdentity.mining && { percent: powPercent(myIdentity.mining.tries) },
    identityFailed: myIdentity.failed,
    ctx: tab?.site
      ? {
          site: tab.site,
          parts: tab.parts,
          enabled: siteEnabled(tab.site),
          incognito: tab.incognito,
          drawMode: !!tab.drawMode,
          myInk: myInk.get(tab.pageKey)?.size ?? 0,
        }
      : null,
    page: roomInfo(pageRoom),
    site: roomInfo(tab && rooms.get(tab.siteKey), pageRoom ?? { members: new Map() }),
    dms: [...dms].map(([id, th]) => ({
      id,
      name: knownPeople.get(id)?.name ?? "?",
      color: knownPeople.get(id)?.color ?? "#888888",
      code: knownPeople.get(id)?.code ?? "",
      online: !!memberAnywhere(id),
      unread: th.unread,
      msgs: th.msgs,
    })),
    log: journal.lines,
  };
}

function cleanSettings(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS) || k === "blocked" || k === "pageRules" || k === "hiddenInk") continue;
    if (k === "name") {
      out.name = cleanName(v);
      out.nameSet = true;
    }
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
    if (["showCursors", "shareCursor", "shareSelection", "color"].some((k) => settings[k] !== before[k])) {
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
  // Ce qui définit le salon de page sur un site : inclure / exclure un paramètre,
  // couper le chemin après n morceaux (null = chemin entier), ou tout remettre par défaut
  setPageParam(site, name, on) {
    if (typeof name !== "string" || name.length > 100) return;
    setPageRule(site, (rule) => {
      const byDefault = !IGNORED_PARAMS.test(name);
      if (!!on === byDefault) delete rule.params[name];
      else rule.params[name] = !!on;
    });
  },
  setPageDepth(site, depth) {
    setPageRule(site, (rule) => {
      rule.depth = Number.isInteger(depth) && depth >= 1 && depth <= 50 ? depth : null;
      if (rule.depth == null) delete rule.depth;
    });
  },
  resetPage(site) {
    setPageRule(site, (rule) => {
      delete rule.depth;
      rule.params = {};
    });
  },
  // Mode dessin de l'onglet actif (seulement dans un salon de page ouvert)
  drawMode(windowId, on) {
    const tab = tabs.get(activeTab.get(windowId));
    if (!tab || !rooms.has(tab.pageKey)) return "errNotConnected";
    setDrawMode(tab, !!on);
    return null;
  },
  clearInk(windowId) {
    const tab = tabs.get(activeTab.get(windowId));
    if (!tab) return;
    clearAllInk(tab);
    tab.port.postMessage({ t: "clearMine" });
  },
  // Afficher / masquer les dessins d'une personne (retenu)
  toggleInk(id) {
    if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) return;
    const { [id]: hidden, ...rest } = settings.hiddenInk;
    settings.hiddenInk = hidden ? rest : { ...rest, [id]: true };
    saveSettings();
    for (const tab of tabs.values()) pushPeers(tab);
    update();
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
      for (const tab of tabs.values()) pushBadge(tab);
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
  if (port.name === "page") {
    // Le script de la page envoie son adresse tout de suite : pendant le démarrage du moteur
    // (installation, activation, ouverture de Firefox), ses messages sont gardés pour après
    let early = [];
    let gone = false;
    port.onMessage.addListener((msg) => early?.push(msg));
    port.onDisconnect.addListener(() => (gone = true));
    ready.then(() => {
      const kept = early;
      early = null;
      if (!gone) connectPage(port, kept);
    });
  }
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
browser.browserAction.setBadgeBackgroundColor({ color: BADGE_COLORS.COUNT });

// Pages ouvertes avant le démarrage du module (installation, activation, mise à jour) : le
// script n'y est pas encore, on l'injecte. Il ne s'installe qu'une fois par page ; les onglets
// pas encore chargés le recevront à leur chargement.
browser.tabs.query({ url: ["http://*/*", "https://*/*"] }).then((list) => {
  for (const tab of list) browser.tabs.executeScript(tab.id, { file: "content.js" }).catch(() => {});
});

// Identité : clé Nostr et preuve de travail (calculée une seule fois), reprises ou créées par
// le kit ; gardées dans browser.storage (« identity », « pow »)
const myIdentity = createIdentity({
  pow,
  read: async () => {
    const stored = await browser.storage.local.get(["identity", "pow"]);
    return { secret: stored.identity, proof: stored.pow };
  },
  write: ({ secret, proof }) => browser.storage.local.set(secret ? { identity: secret } : { pow: proof }),
  onChange: () => update(),
  onReady: (code) => {
    log(t("logIdentityReady", code));
    reconcile();
  },
});
const identity = myIdentity.identity; // { secret, pubkey, pow, code } : rempli par le kit

async function init() {
  const stored = await browser.storage.local.get(["settings", "identity", "pow", "ink"]);
  for (const [pageKey, list] of Object.entries(stored.ink ?? {})) {
    if (Array.isArray(list) && list.length) myInk.set(pageKey, new Map(list.map((st) => [st.id, st])));
  }
  settings = { ...DEFAULTS, ...stored.settings };
  // Anciens réglages d'anti-flood (0.1 à 0.3) : les limites sont désormais fixes
  delete settings.sendRate;
  delete settings.recvRate;
  // Réglages d'avant nameSet : un pseudo déjà changé compte comme choisi
  if (stored.settings?.name && !isProposedName(stored.settings.name)) settings.nameSet = true;
  if (!settings.name) settings.name = proposedName();
  if (!settings.color) settings.color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  setLang(settings.lang);
  await browser.storage.local.set({ settings });
  await myIdentity.load();
  for (const tab of await browser.tabs.query({ active: true })) activeTab.set(tab.windowId, tab.id);
}

const ready = init();
