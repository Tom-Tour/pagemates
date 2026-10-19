"""Real-network end-to-end test: two separate headless Firefox instances with Pagemates.

Uses the real PeerJS server, public Nostr relays and WebRTC, on a Wikipedia page with a
random parameter (so the page room is private to the test). Needs Firefox 140+ and
Selenium (pip install -r requirements.txt). Run: python tests/e2e/run.py

The extension is copied to .out/build with two test-only files added: a bridge that
exposes the engine's state to the test page, and its background helper.
"""
import json, os, random, shutil, string, sys, time
from selenium import webdriver
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.abspath(os.path.join(HERE, "..", ".."))
SP = os.path.join(HERE, ".out")
BUILD = os.path.join(SP, "build")
UUID = "5e1f0c6a-7a39-4b8e-9a51-2d4c3b1a0f00"
TAG = "".join(random.choices(string.ascii_lowercase, k=8))
PAGE = f"https://fr.wikipedia.org/wiki/Paris?pmtest={TAG}"
OBFUSCATE = "--no-obfuscate" not in sys.argv

shutil.rmtree(BUILD, ignore_errors=True)
shutil.copytree(SRC, BUILD, ignore=shutil.ignore_patterns(".git", ".github", "tests"))
for f in ("probe-content.js", "probe-bg.js"):
    shutil.copy(os.path.join(HERE, f), BUILD)
man = json.load(open(os.path.join(BUILD, "manifest.json"), encoding="utf-8"))
man["background"]["scripts"].append("probe-bg.js")
man["content_scripts"].append({"matches": ["https://fr.wikipedia.org/*"], "js": ["probe-content.js"], "run_at": "document_idle"})
json.dump(man, open(os.path.join(BUILD, "manifest.json"), "w", encoding="utf-8"), indent=2)

results = []
def check(name, ok, extra=""):
    results.append((name, ok))
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else "  " + str(extra)), flush=True)

def start(label):
    o = Options()
    o.add_argument("-headless")
    o.set_preference("extensions.webextensions.uuids", json.dumps({"pagemates@tom-tour": UUID}))
    if not OBFUSCATE:
        o.set_preference("media.peerconnection.ice.obfuscate_host_addresses", False)
    d = webdriver.Firefox(options=o)
    d.set_window_size(1100, 800)
    d.install_addon(BUILD, temporary=True)
    d.get(PAGE)
    d.page_tab = d.current_window_handle
    d.label = label
    return d

def snap(d):
    d.switch_to.window(d.page_tab)
    raw = d.execute_script("return document.documentElement.getAttribute('data-pm-snap')")
    return json.loads(raw) if raw else None

REQ = [0]
def ask(d, cmd, *args):
    d.switch_to.window(d.page_tab)
    REQ[0] += 1
    req = REQ[0]
    d.execute_script("window.postMessage({ pmProbe: true, cmd: arguments[0], args: arguments[1], req: arguments[2] }, '*')", cmd, list(args), req)
    for _ in range(100):
        raw = d.execute_script("return document.documentElement.getAttribute('data-pm-reply-' + arguments[0])", req)
        if raw is not None:
            return json.loads(raw)
        time.sleep(0.05)
    return "timeout"

def win(d):
    d.switch_to.window(d.page_tab)
    return int(d.execute_script("return document.documentElement.getAttribute('data-pm-window')"))

def wait_for(d, cond, timeout, step=0.5):
    end = time.time() + timeout
    while time.time() < end:
        s = snap(d)
        try:
            if s and cond(s):
                return s
        except (KeyError, TypeError, IndexError):
            pass
        time.sleep(step)
    return None

t0 = time.time()
A = start("A")
B = start("B")
print(f"browsers up in {time.time() - t0:.1f}s, page {PAGE}", flush=True)

# 1. proof of work in real Firefox
t1 = time.time()
sa = wait_for(A, lambda s: s["mining"] is None and s["myCode"], 300)
sb = wait_for(B, lambda s: s["mining"] is None and s["myCode"], 300)
check(f"identities mined (A {sa and sa['myCode']}, B {sb and sb['myCode']}) in {time.time() - t1:.0f}s", bool(sa and sb))

# 2. join the site, meet on the page (real PeerJS + Nostr + WebRTC)
for d in (A, B):
    ask(d, "setSite", "fr.wikipedia.org", True)
t2 = time.time()
sa = wait_for(A, lambda s: len(s["page"]["people"]) == 1, 120)
sb = wait_for(B, lambda s: len(s["page"]["people"]) == 1, 120)
met = bool(sa and sb)
check(f"A and B meet on the page in {time.time() - t2:.0f}s", met, json.dumps(snap(A).get("page")) if not met else "")
if met:
    codeA, codeB = snap(A)["myCode"], snap(B)["myCode"]
    check("each sees the other's identity code", sa["page"]["people"][0]["code"] == codeB and sb["page"]["people"][0]["code"] == codeA)
    sb2 = wait_for(B, lambda s: len(s["site"]["people"]) == 1, 60)
    check("they also meet in the site room", bool(sb2))

    # 3. chat, page and site
    check("page chat sent", ask(A, "chat", win(A), "page", "bonjour la page") is None)
    check("page chat received", bool(wait_for(B, lambda s: any(m.get("text") == "bonjour la page" for m in s["page"]["chat"]), 20)))
    time.sleep(1.1)
    ask(A, "chat", win(A), "site", "bonjour le site")
    check("site chat received", bool(wait_for(B, lambda s: any(m.get("text") == "bonjour le site" for m in s["site"]["chat"]), 20)))

    # 4. private message
    pubB = snap(B)["me"]
    time.sleep(1.1)
    check("private message sent", ask(A, "dm", pubB, "message privé de A") is None)
    s = wait_for(B, lambda s: any(m.get("text") == "message privé de A" for d in s["dms"] for m in d["msgs"]), 20)
    check("private message received, unread", bool(s and s["dms"][0]["unread"] == 1))

    # 5. cursor and drawing, seen in B's page (screenshots)
    A.switch_to.window(A.page_tab)
    para = A.find_elements(By.CSS_SELECTOR, "#mw-content-text p")
    para = next(p for p in para if p.text.strip())
    ActionChains(A).move_to_element_with_offset(para, -100, 0).pause(0.3).move_to_element_with_offset(para, 0, 0).pause(0.5).perform()
    check("draw mode on", ask(A, "drawMode", win(A), True) is None)
    A.switch_to.window(A.page_tab)
    time.sleep(0.5)
    chain = ActionChains(A).move_to_element_with_offset(para, -200, -5).click_and_hold()
    for i in range(1, 21):
        chain.move_by_offset(10, (i % 4) * 3 - 4).pause(0.03)
    chain.release().pause(0.3).move_to_element_with_offset(para, 120, 10).perform()
    time.sleep(2)
    B.switch_to.window(B.page_tab)
    B.execute_script("arguments[0].scrollIntoView({block: 'center'})", B.find_elements(By.CSS_SELECTOR, "#mw-content-text p")[[p.text.strip() != "" for p in B.find_elements(By.CSS_SELECTOR, "#mw-content-text p")].index(True)])
    A.switch_to.window(A.page_tab)
    A.execute_script("arguments[0].scrollIntoView({block: 'center'})", para)
    time.sleep(1)
    A.save_screenshot(os.path.join(SP, "real-A.png"))
    B.save_screenshot(os.path.join(SP, "real-B.png"))
    check("A's drawing stored (1 stroke)", snap(A)["ctx"]["myInk"] == 1, snap(A)["ctx"])
    ask(A, "drawMode", win(A), False)

    # 6. block
    pubA = snap(A)["me"]
    ask(B, "block", pubA)
    check("after B blocks A, they no longer see each other", bool(wait_for(A, lambda s: len(s["page"]["people"]) == 0, 20)) and bool(wait_for(B, lambda s: len(s["page"]["people"]) == 0, 5)))

for d in (A, B):
    d.quit()
failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed, total {time.time() - t0:.0f}s")
sys.exit(1 if failed else 0)
