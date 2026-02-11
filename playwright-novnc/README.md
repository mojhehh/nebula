# Playwright + noVNC TikTok Proxy

A real browser streamed to users via noVNC. No need for Service Workers or URL rewriting - TikTok runs in a real Chrome browser!

## Prerequisites

- Docker Desktop installed

## Quick Start

```bash
# Build and run
docker-compose up --build

# Or run detached
docker-compose up -d --build
```

## Access

- **Main App**: http://localhost:3000
- **noVNC Direct**: http://localhost:6080/vnc.html

## How It Works

1. User clicks "Connect" → Creates a Playwright browser session
2. Browser runs in headed mode inside Docker (on virtual X11 display)
3. x11vnc captures the display and streams via VNC protocol
4. noVNC converts VNC to WebSocket so browser can view it
5. User sees the real Chrome browser and can interact with it!

## Ports

| Port | Service |
|------|---------|
| 3000 | Express API + Frontend |
| 6080 | noVNC Web Viewer |
| 5900 | VNC (internal) |

## Cloudflare Tunnel

To expose via Cloudflare:
```bash
cloudflared tunnel --url http://localhost:6080
```

Then share the tunnel URL - users can view TikTok through the browser!

## Notes

- Each user gets their own browser session (isolated)
- Sessions auto-expire after 30 minutes
- Uses 2GB shared memory for Chromium (adjust in docker-compose.yml)
