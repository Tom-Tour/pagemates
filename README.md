# Pagemates

A Firefox extension that turns every web page into a room: chat with the people on the same page or the same site, and see their cursors, clicks and highlights live.

**English** · [Français](README.fr.md)

> Early version.

[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/tom_t)

## Features

- **Two rooms per page**: one for the exact page, one for the whole site. Show both, or only one (settings)
- **Live cursors** in the color you pick, anchored to page elements rather than pixels: a cursor lands on the same button or paragraph even with a different screen size, zoom or layout. When the element doesn't exist on your side (personalized content), the cursor is shown faded at an approximate position; when it's off screen, an arrow on the edge shows where it is
- **Clicks**: a colored ripple and outline on the element someone clicks (display only, nothing is clicked for you)
- **Highlights**: text selected by others is highlighted in their color, found by quote (text plus surrounding words), so it survives layout differences
- **Channels**, like in online games: a room holds up to 20 people; beyond that, newcomers open channel #2, #3… Pick any channel by its number (give it to your friends to meet up), switch to another one, or open an empty one
- **Private messages** to anyone you share a room with
- **Anti-flood**, the same fixed rule for everyone: 2 messages per second at most; messages beyond the limit (from a modified extension) are ignored, and someone who keeps flooding is muted for a minute
- **Block** someone for good, from the people list or from private messages: their cursor, highlights and messages (earlier ones included) disappear, and they stop receiving yours. Identities are signed keys, so nobody can impersonate them, and each identity costs a proof of work (see below), so a blocked person can't just come back with thousands of new ones
- **Disconnect** from everything in one click, or leave a single site
- English and French

## Privacy

- **Off by default**: each site is joined on demand (sidebar → Join), unless you turn on "Join every site automatically". Never in private browsing, never automatically on local addresses
- Nothing goes through a server of ours. People find each other through public Nostr relays, which only ever see a hash of the site, never the address. Everything else (chat, cursors, private messages) goes directly between browsers (WebRTC, encrypted)
- People in a room know you're on that site, and on which page when you share it with them
- As with any peer-to-peer connection, the people you're connected to can see your IP address
- Cursor positions never contain page text. Highlights do send the selected text (you can turn that off). Form fields are never read
- No history: messages live in memory only and vanish when you leave

## Anti-spam proof of work

On first launch, the extension spends about 30 seconds (only once) finding a number that makes `scrypt(identity + number)` start with 8 zero bits. Others check it in a fraction of a second during the handshake and refuse identities without it. scrypt needs 16 MB of memory per try, so graphics cards barely speed it up, unlike a plain hash.

It turns "free" fake accounts into costly ones: a thousand identities take a script running in a browser about an hour, even using every core. A determined attacker with a powerful machine and optimized code still needs minutes: it's a barrier against casual spam, not a fortress.

## Install (development)

1. Open `about:debugging#/runtime/this-firefox`
2. "Load Temporary Add-on…" and pick `manifest.json`
3. Click the toolbar button (or Alt+Shift+P) to open the sidebar

The sidebar settings (⚙) end with an **About** section linking to this page and to Ko-fi.

## How it works

- `content.js` runs in every page: sends your cursor, clicks and selection, and draws other people's in a closed Shadow DOM layer
- `rooms.js`: one peer-to-peer mesh per room and channel (PeerJS, one connection to its server per site), presence on Nostr (which also tells who is on which channel), signed handshake, chat, private messages, rate limits
- `background.js`: settings, tabs, sidebar link
- `pow-worker.js`: proof of work, computed off the main thread
- Third-party: [PeerJS](https://peerjs.com), [nostr-tools](https://github.com/nbd-wtf/nostr-tools), [scrypt-js](https://github.com/ricmoo/scrypt-js) (MIT)

## Support

If you like Pagemates, you can support its development on [Ko-fi](https://ko-fi.com/tom_t) ☕

## License

Copyright (C) 2026 tom.tourbez

Pagemates is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY. See [LICENSE](LICENSE) for the full text (GPL-3.0-or-later).
