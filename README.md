<div align="center">

<br />

```
  ███████╗ ██████╗ ██████╗
  ██╔════╝██╔════╝ ╚════██╗
  ███████╗███████╗  █████╔╝
  ╚════██║██╔═══██╗ ╚═══██╗
  ███████║╚██████╔╝██████╔╝
  ╚══════╝ ╚═════╝ ╚═════╝
```

**Private. Real-time. Yours.**

![Status](https://img.shields.io/badge/status-live-3ecf8e?style=flat-square&labelColor=1e1e21)
![Stack](https://img.shields.io/badge/stack-vanilla%20JS-5b6af0?style=flat-square&labelColor=1e1e21)
![License](https://img.shields.io/badge/license-MIT-8a8a8f?style=flat-square&labelColor=1e1e21)

<br />

</div>

---

## Overview

**Nut** is a minimal, password-protected real-time chat room with voice and video calling — built entirely with vanilla JS, no backend required.

Messages are delivered over MQTT (WebSocket). Calls are peer-to-peer via WebRTC. Everything runs in the browser.

---

## Features

| Feature                 | Details                                                   |
| ----------------------- | --------------------------------------------------------- |
| 💬 Real-time messaging  | MQTT over WebSocket — 3 broker fallbacks                  |
| � Private rooms         | Room name + password required; messages isolated per room |
| 👑 Admin access         | Admin user 563 can access rooms without room password     |
| �🔒 Password protection | SHA-256 hashed, never stored in plaintext                 |
| 📞 Voice calls          | WebRTC via PeerJS                                         |
| 📹 Video calls          | Camera + mic with mute/cam toggle                         |
| ✍️ Typing indicators    | Live animated dots                                        |
| 🟢 Presence             | Online count with 10s heartbeat                           |
| 🗑️ Clear history        | Synced clear for all users                                |
| 💾 Local history        | Persists across refreshes via localStorage                |
| 📱 Mobile ready         | iOS safe-area, 44px touch targets                         |

---

## Stack

```
Browser only — zero backend, zero build step

MQTT     →  broker.emqx.io  (+ 2 fallbacks)
WebRTC   →  PeerJS (0.peerjs.com)
Fonts    →  Inter via Google Fonts
```

---

## Getting Started

**Open directly:**

```
Nut/index.html  →  double-click or drag into browser
```

**Serve locally** (recommended for camera/mic):

```bash
cd Nut
npx serve .
# → http://localhost:3000
```

**Test on phone:**

```bash
npx serve . --listen 0.0.0.0
# → open http://YOUR_LOCAL_IP:3000 on phone
```

---

## Default Password

```
Nutroom
```

**To change it** — generate a new SHA-256 hash and replace `CHAT_PASSWORD_HASH` in `chat.js`:

```bash
node -e "const c=require('crypto'); console.log(c.createHash('sha256').update('YOUR_PASSWORD').digest('hex'))"
```

---

## Design System

| Token     | Value     | Usage                         |
| --------- | --------- | ----------------------------- |
| `--bg`    | `#0d0d0d` | Page background               |
| `--sur`   | `#161618` | Cards, panels                 |
| `--sur2`  | `#1e1e21` | Inputs, bubbles               |
| `--acc`   | `#5b6af0` | Accent, buttons, own messages |
| `--txt`   | `#ececec` | Primary text                  |
| `--txt2`  | `#8a8a8f` | Secondary text                |
| `--txt3`  | `#4a4a50` | Muted / timestamps            |
| `--green` | `#3ecf8e` | Online, voice call            |
| `--red`   | `#f06060` | Errors, danger                |

**Font:** [Inter](https://fonts.google.com/specimen/Inter) — weights 300 / 400 / 500 / 600

---

## File Structure

```
Nut/
├── index.html     UI — join screen, chat, modals
├── chat.js        MQTT messaging, presence, typing, history
├── call.js        WebRTC voice & video via PeerJS
├── style.css      Design system & all component styles
└── README.md
```

---

## Browser Support

Chrome · Firefox · Safari · Edge · iOS Safari · Android Chrome

> Camera/mic require HTTPS or localhost.

---

<div align="center">

<br />

Made with care &nbsp;·&nbsp; No tracking &nbsp;·&nbsp; No server &nbsp;·&nbsp; No noise

<br />

</div>
