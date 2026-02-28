# Nebula

Private cloud browser service. Each user gets their own isolated Chrome instance streamed via WebRTC.

## Architecture

- **10 Neko containers** (`neko1`–`neko10`) running Chrome with WebRTC streaming
- **Node.js proxy** (`neko-proxy.js`) handles session management, browser assignment, and reverse proxying
- **Cloudflare tunnel** exposes the service publicly
- **Firebase** persists session state across restarts
- **Self-hosted coturn** (DigitalOcean VPS) for TURN relay

## Stack

- [n.eko](https://github.com/m1k1o/neko) — WebRTC browser containers
- Node.js + `http-proxy` — session manager and reverse proxy
- Cloudflare Tunnel — public access without port forwarding
- coturn — TURN server for NAT traversal
- Firebase Realtime Database — state persistence

## Local Setup

```bash
cd neko-browser
npm install
node neko-proxy.js
```

Requires Docker containers `neko1`–`neko10` running on ports 3611–3619 and 3630.

## Structure

```
index.html                  GitHub Pages landing page
neko-browser/
  neko-proxy.js             Main proxy server (port 3600)
  neko-loading.html         Custom Neko client with branded loader
  nebula-ipad.js            iPad touch controls and auto-login
  neko.yaml                 Neko container config (H264, TURN)
  docker-compose.yml        Container definitions
  recreate-containers.ps1   Container management script
  turnserver.conf           coturn reference config
```
