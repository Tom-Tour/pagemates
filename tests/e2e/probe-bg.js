// Test build only: tells the bridge which window its tab is in.
browser.runtime.onMessage.addListener((msg, sender) => (msg === "pm-whoami" ? Promise.resolve(sender.tab.windowId) : undefined));
// Test build only: addresses of the tabs the engine follows.
browser.runtime.onMessage.addListener((msg) => (msg === "pm-tabs" ? Promise.resolve([...tabs.values()].map((t) => t.url)) : undefined));
