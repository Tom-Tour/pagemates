# <img src="icons/icon.svg" width="40" align="top" alt=""> Pagemates

A Firefox extension that turns every web page into a room: chat with the people on the same page or the same site, and see their cursors, clicks and highlights live.

**English** · [Français](README.fr.md)

> Early version.

[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/tom_t)

## Features

- **Two rooms per page**: one for the exact page, one for the whole site. Show both, or only one (settings)
- **Live cursors** in the color you pick, anchored to page elements rather than pixels: a cursor lands on the same button or paragraph even with a different screen size, zoom or layout. When the element doesn't exist on your side (personalized content), the cursor is shown faded at an approximate position; when it's off screen, an arrow on the edge shows where it is
- **Clicks**: a colored ripple and outline on the element someone clicks (display only, nothing is clicked for you)
- **Highlights**: text selected by others is highlighted in their color, found by quote (text plus surrounding words), so it survives layout differences
- **Channels**, like in online games: a room holds up to 20 people; beyond that, newcomers open channel #2, #3… Click the channel to pick another one from the list, or type any number (give it to your friends to meet up)
- **You choose what "the page" means**: the sidebar shows the page address in pieces. Ignored parameters are struck through (tracking, video timestamp, playlist…), so people arriving through different links still meet. Click a parameter to include or ignore it, or click a part of the path to cut the address there and get one room for a whole section (`reddit.com/r/france`). Choices are remembered per site; people meet as soon as they end up with the same address
- **Drawings**: switch on drawing mode (✏️ Draw) and draw right on the page; strokes stick to the page elements like cursors do. Your drawings are kept on your computer, page by page, and shown to the people on the page whenever you're there (without a server, nobody else keeps them). Ctrl+Z undoes the last stroke, Esc leaves drawing mode. Hide anyone's drawings from their card
- **Private messages** to anyone you share a room with
- **Anti-flood**, the same fixed rule for everyone: 2 messages per second at most; messages beyond the limit (from a modified extension) are ignored, and someone who keeps flooding is muted for a minute
- **Identity code**: a 4-character code follows every name. It's tied to the identity, so someone taking your nickname won't have your code, and faking someone's code would take about an hour of computation on a powerful machine
- **Private messages** you receive show on the toolbar button (✉ and a count), with a notification when the sidebar is closed
- **Block** someone for good, from their card (click their name, then Block… and confirm): their cursor, highlights and messages (earlier ones included) disappear, and they stop receiving yours. Identities are signed keys, so nobody can impersonate them, and each identity costs a proof of work (see below), so a blocked person can't just come back with thousands of new ones
- **Disconnect** from everything in one click, or leave a single site
- English and French

## Privacy

- **Off by default**: each site is joined on demand (sidebar → Join), unless you turn on "Join every site automatically". Never in private browsing, never automatically on local addresses
- Nothing goes through a server of ours. People find each other through public Nostr relays, which receive a hash of the page and of the site rather than the address. That hides private addresses, but not public pages: anyone can compute the hash of a known address and see whether people are on it. Everything else (chat, cursors, private messages) goes directly between browsers (WebRTC, encrypted)
- People in a room know you're on that site, and on which page when you share it with them
- As with any peer-to-peer connection, the people you're connected to can see your IP address
- Cursor positions never contain page text. Highlights do send the selected text (you can turn that off). Form fields are never read
- No history: messages live in memory only and vanish when you leave

Firefox asks for your consent at install (Firefox 140 or later): the extension transmits your browsing activity (which pages you're on, as hashes), your activity on the page (cursor, clicks), page content (highlighted text) and your messages, to the people in your rooms only.

## Anti-spam proof of work

On first launch, the extension spends about 20 seconds (only once) finding a number that makes `scrypt(identity + number)` start with 7 zero bits. Others check it in a fraction of a second during the handshake and refuse identities without it. scrypt needs 4 MB of memory per try, so graphics cards barely speed it up, unlike a plain hash.

It turns "free" fake accounts into costly ones: a thousand identities take a script running in a browser about an hour, even using every core. A determined attacker with a powerful machine and optimized code can still make a thousand in a minute or two: it's a barrier against casual spam, not a fortress. The cost was set so that it stays short in Firefox (about 20 seconds once), since a heavier proof took over two minutes there.

## Install (development)

1. Open `about:debugging#/runtime/this-firefox`
2. "Load Temporary Add-on…" and pick `manifest.json`
3. Click the toolbar button (or Alt+Shift+P) to open the sidebar

The sidebar settings (⚙) end with an **About** section linking to this page and to Ko-fi.

## How it works

- `content.js` runs in every page: sends your cursor, clicks and selection, and draws other people's in a closed Shadow DOM layer
- `rooms.js`: one peer-to-peer mesh per room and channel (PeerJS, one connection to its server per site), presence on Nostr (which also tells who is on which channel), signed handshake, chat, private messages, rate limits
- `background.js`: settings, tabs, sidebar link
- `common/`: base shared with the other Tom-Tour extensions (theme, vocabulary, room security, proof of work), so they look and behave alike
- Third-party: [PeerJS](https://peerjs.com), [nostr-tools](https://github.com/nbd-wtf/nostr-tools), [scrypt-js](https://github.com/ricmoo/scrypt-js) (MIT, in `common/`)

## Tests

- `cd tests && npm install && npm test`: engine (several engines on a simulated network), page script and sidebar
- `python tests/e2e/run.py`: two real Firefox instances on the real network (PeerJS, Nostr relays, WebRTC), with Selenium (`pip install -r tests/e2e/requirements.txt`)

## Support

If you like Pagemates, you can support its development on [Ko-fi](https://ko-fi.com/tom_t) ☕

## License

Copyright (C) 2026 tom.tourbez

Pagemates is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY. See [LICENSE](LICENSE) for the full text (GPL-3.0-or-later).
