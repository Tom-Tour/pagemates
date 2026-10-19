// Test build only: bridges the engine (as a sidebar would see it) to the test page DOM.
(async () => {
  if (!location.search.includes("pmtest=")) return;
  const root = document.documentElement;
  const windowId = await browser.runtime.sendMessage("pm-whoami");
  const port = browser.runtime.connect({ name: "sidebar" });
  port.onMessage.addListener((msg) => {
    if (msg.t === "reply") root.setAttribute("data-pm-reply-" + msg.req, JSON.stringify(msg.error ?? null));
    else root.setAttribute("data-pm-snap", JSON.stringify(msg.snap));
  });
  port.postMessage({ cmd: "hello", args: [windowId] });
  root.setAttribute("data-pm-window", String(windowId));
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data?.pmProbe) port.postMessage({ cmd: e.data.cmd, args: e.data.args, req: e.data.req });
  });
})();
