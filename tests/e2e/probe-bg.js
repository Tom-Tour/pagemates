// Test build only: tells the bridge which window its tab is in.
browser.runtime.onMessage.addListener((msg, sender) => (msg === "pm-whoami" ? Promise.resolve(sender.tab.windowId) : undefined));
