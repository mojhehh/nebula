/**
 * Nebula Browser Session Manager — Neko WebRTC Reverse Proxy
 *
 * Single server that handles:
 * - Landing page and session management
 * - Reverse proxy to 10 Neko WebRTC containers
 * - WebSocket proxying (Neko control + WebRTC signaling)
 * - Firebase state persistence (survives restarts)
 * - Two-token access control (cookie + one-time URL token)
 *
 * Routes:
 * - /                    -> Landing page
 * - /api/*               -> Session management API
 * - /browser/1/*         -> Proxy to Neko container 1 (port 3611)
 * - /browser/2/*         -> Proxy to Neko container 2 (port 3612)
 * - ... up to /browser/10/*
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const httpProxy = require('http-proxy');

// ─── Firebase Admin SDK ───────────────────────────────────────────────────────
let db = null;
try {
  const admin = require('firebase-admin');
  // Look for service account in browser-sessions (shared with old proxy)
  const serviceAccountPath = path.join(__dirname, '..', 'browser-sessions', 'firebase-service-account.json');

  if (fs.existsSync(serviceAccountPath)) {
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: 'https://nebula-60629-default-rtdb.firebaseio.com'
    });
    db = admin.database();
    console.log('[Firebase] Nebula Realtime Database connected');
  } else {
    console.log('[Firebase] Service account not found at:', serviceAccountPath);
  }
} catch (err) {
  console.log('[Firebase] Init error:', err.message);
}

// ─── Global error handlers ────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});

// ─── Browser pool — Neko containers ───────────────────────────────────────────
// Port mapping matches the Docker containers created:
//   neko1:3611, neko2:3612, ..., neko9:3619, neko10:3630
const BROWSERS = [
  { id: 1,  port: 3611, host: 'localhost', inUse: false, lastUsed: null, lastHeartbeat: null, userId: null, sessionId: null, clientId: null },
  { id: 2,  port: 3612, host: 'localhost', inUse: false, lastUsed: null, lastHeartbeat: null, userId: null, sessionId: null, clientId: null },
  { id: 3,  port: 3613, host: 'localhost', inUse: false, lastUsed: null, lastHeartbeat: null, userId: null, sessionId: null, clientId: null },
  { id: 4,  port: 3614, host: 'localhost', inUse: false, lastUsed: null, lastHeartbeat: null, userId: null, sessionId: null, clientId: null },
  { id: 5,  port: 3615, host: 'localhost', inUse: false, lastUsed: null, lastHeartbeat: null, userId: null, sessionId: null, clientId: null },
  { id: 6,  port: 3616, host: 'localhost', inUse: false, lastUsed: null, lastHeartbeat: null, userId: null, sessionId: null, clientId: null },
  { id: 7,  port: 3617, host: 'localhost', inUse: false, lastUsed: null, lastHeartbeat: null, userId: null, sessionId: null, clientId: null },
  { id: 8,  port: 3618, host: 'localhost', inUse: false, lastUsed: null, lastHeartbeat: null, userId: null, sessionId: null, clientId: null },
  { id: 9,  port: 3619, host: 'localhost', inUse: false, lastUsed: null, lastHeartbeat: null, userId: null, sessionId: null, clientId: null },
  { id: 10, port: 3630, host: 'localhost', inUse: false, lastUsed: null, lastHeartbeat: null, userId: null, sessionId: null, clientId: null },
];

// ─── Proxy server ─────────────────────────────────────────────────────────────
const proxy = httpProxy.createProxyServer({
  ws: true,
  changeOrigin: true,
  xfwd: true,
});

proxy.on('proxyReq', (proxyReq, req) => {
  if (!/\.(svg|png|jpg|jpeg|gif|woff2?|ttf|eot|css|js|ico)$/i.test(proxyReq.path)) {
    console.log(`[HTTP] ${req.method} ${req.url} -> ${proxyReq.path}`);
  }
});

// Inject CORS headers into proxied responses so browser doesn't block them
proxy.on('proxyRes', (proxyRes) => {
  proxyRes.headers['access-control-allow-origin'] = '*';
  proxyRes.headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
  proxyRes.headers['access-control-allow-headers'] = 'Content-Type';
});

proxy.on('error', (err, req, res) => {
  console.error('[Proxy Error]', err.message);
  if (res && res.writeHead) {
    res.writeHead(502, {
      'Content-Type': 'text/html',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(`
      <html><head><title>Connecting...</title></head>
      <body style="background:#0d0620;color:#fff;font-family:Inter,system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
        <div style="text-align:center;">
          <div style="font-size:48px;margin-bottom:20px;">🌌</div>
          <h1 style="margin:0 0 10px;">Browser Starting Up...</h1>
          <p style="color:#aaa;margin:0 0 20px;">The container is restarting. Auto-retrying in <span id="cd">5</span>s</p>
          <button onclick="location.reload()" style="padding:10px 24px;font-size:15px;cursor:pointer;background:#7c3aed;color:#fff;border:none;border-radius:8px;">Retry Now</button>
        </div>
        <script>var s=5,cd=document.getElementById('cd');setInterval(function(){s--;cd.textContent=s;if(s<=0)location.reload();},1000);</script>
      </body></html>
    `);
  }
});

proxy.on('open', () => { /* WebSocket opened to upstream */ });
proxy.on('close', () => { /* WebSocket closed */ });

// ─── Session timeouts ─────────────────────────────────────────────────────────
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;     // 5 min no heartbeat → release
const WS_PRESENCE_TIMEOUT_MS = 2 * 60 * 1000; // 2 min no WS after disconnect → release

// ─── Session tracking maps ────────────────────────────────────────────────────
const sessions = new Map();          // sessionId -> { browserId, clientId, createdAt, lastActivity }
const clientSessions = new Map();    // clientId -> browserId
const activeConnections = new Map(); // browserId -> { count, lastDisconnect }

// ─── Two-token access control ─────────────────────────────────────────────────
const browserTokens = new Map();     // browserId -> cookieToken
const tokenToBrowser = new Map();    // cookieToken -> browserId
const urlTokens = new Map();         // urlToken -> { browserId, cookieToken, createdAt }

function generateSecureToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createSessionTokens(browserId) {
  const oldCookieToken = browserTokens.get(browserId);
  if (oldCookieToken) tokenToBrowser.delete(oldCookieToken);

  const cookieToken = generateSecureToken();
  const urlToken = generateSecureToken();

  browserTokens.set(browserId, cookieToken);
  tokenToBrowser.set(cookieToken, browserId);
  urlTokens.set(urlToken, { browserId, cookieToken, createdAt: Date.now() });

  return { cookieToken, urlToken };
}

function createUrlToken(browserId) {
  const cookieToken = browserTokens.get(browserId);
  if (!cookieToken) return null;
  const urlToken = generateSecureToken();
  urlTokens.set(urlToken, { browserId, cookieToken, createdAt: Date.now() });
  return urlToken;
}

function validateBrowserAccess(req, browserId) {
  const cookies = parseCookies(req);
  const token = cookies.nebula_session;
  if (!token) return false;
  return tokenToBrowser.get(token) === browserId;
}

function cleanupUrlTokens() {
  const now = Date.now();
  for (const [token, entry] of urlTokens) {
    if (now - entry.createdAt > 5 * 60 * 1000) urlTokens.delete(token);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateSessionId() {
  return 'sess_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

function getBrowserById(id) {
  return BROWSERS.find(b => b.id === id);
}

function findAvailableBrowser() {
  return BROWSERS.find(b => !b.inUse);
}

function findBrowserByClientId(clientId) {
  if (!clientId) return null;
  const browserId = clientSessions.get(clientId);
  if (!browserId) return null;
  const browser = getBrowserById(browserId);
  if (browser && browser.inUse && browser.clientId === clientId) return browser;
  clientSessions.delete(clientId);
  return null;
}

function parseBrowserPath(pathname) {
  const match = pathname.match(/^\/browser\/(\d+)(\/.*)?$/);
  if (!match) return null;
  return { browserId: parseInt(match[1], 10), remainingPath: match[2] || '/' };
}

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (header) {
    header.split(';').forEach(c => {
      const [name, value] = c.trim().split('=');
      if (name && value) cookies[name] = value;
    });
  }
  return cookies;
}

function getBrowserFromCookie(req) {
  const cookies = parseCookies(req);
  const id = parseInt(cookies.nebula_browser, 10);
  if (id >= 1 && id <= BROWSERS.length) return getBrowserById(id);
  return null;
}

// ─── Firebase state persistence ───────────────────────────────────────────────

async function syncBrowserToFirebase(browser) {
  if (!db) return;
  try {
    await db.ref(`nebula/browsers/state/${browser.id}`).set({
      inUse: browser.inUse,
      clientId: browser.clientId || null,
      sessionId: browser.sessionId || null,
      lastUsed: browser.lastUsed || null,
      lastHeartbeat: browser.lastHeartbeat || null,
    });
    await updateBrowserSummary();
  } catch (err) {
    console.log(`[Firebase] Sync error for browser ${browser.id}: ${err.message}`);
  }
}

async function restoreStateFromFirebase() {
  if (!db) {
    console.log('[Firebase] No DB connection, starting with clean state');
    return;
  }
  try {
    const snapshot = await db.ref('nebula/browsers/state').once('value');
    const state = snapshot.val();
    if (!state) {
      console.log('[Firebase] No existing state found, starting fresh');
      return;
    }

    let restored = 0;
    for (const browser of BROWSERS) {
      const saved = state[browser.id];
      if (saved && saved.inUse) {
        const age = Date.now() - (saved.lastHeartbeat || saved.lastUsed || 0);
        if (age < SESSION_TIMEOUT_MS) {
          browser.inUse = true;
          browser.clientId = saved.clientId;
          browser.sessionId = saved.sessionId;
          browser.lastUsed = saved.lastUsed;
          browser.lastHeartbeat = saved.lastHeartbeat;

          if (saved.sessionId) {
            sessions.set(saved.sessionId, {
              browserId: browser.id,
              clientId: saved.clientId,
              createdAt: saved.lastUsed,
              lastActivity: saved.lastHeartbeat || saved.lastUsed,
            });
          }
          if (saved.clientId) clientSessions.set(saved.clientId, browser.id);

          const cookieToken = generateSecureToken();
          browserTokens.set(browser.id, cookieToken);
          tokenToBrowser.set(cookieToken, browser.id);
          activeConnections.set(browser.id, { count: 0, lastDisconnect: null });
          restored++;
        } else {
          console.log(`[Firebase] Clearing stale session for browser ${browser.id} (age: ${Math.round(age / 1000)}s)`);
          await db.ref(`nebula/browsers/state/${browser.id}`).set({ inUse: false });
        }
      }
    }
    console.log(`[Firebase] Restored ${restored} active sessions from Firebase`);
  } catch (err) {
    console.log(`[Firebase] Restore error: ${err.message}`);
  }
}

async function updateBrowserSummary() {
  if (!db) return;
  try {
    const inUse = BROWSERS.filter(b => b.inUse).length;
    const available = BROWSERS.filter(b => !b.inUse).length;
    await db.ref('nebula/browsers/summary').set({
      inUse,
      available,
      total: BROWSERS.length,
      updatedAt: Date.now(),
      browsers: BROWSERS.map(b => ({ id: b.id, available: !b.inUse })),
    });
  } catch (err) {
    console.log(`[Firebase] Summary error: ${err.message}`);
  }
}

// ─── Release a browser slot ───────────────────────────────────────────────────

function doReleaseBrowser(browser, reason) {
  if (!browser || !browser.inUse) return;

  console.log(`[Release] Browser ${browser.id} released (${reason})`);

  for (const [sessionId, session] of sessions) {
    if (session.browserId === browser.id) { sessions.delete(sessionId); break; }
  }

  if (browser.clientId) clientSessions.delete(browser.clientId);

  const oldToken = browserTokens.get(browser.id);
  if (oldToken) { tokenToBrowser.delete(oldToken); browserTokens.delete(browser.id); }
  for (const [ut, entry] of urlTokens) {
    if (entry.browserId === browser.id) urlTokens.delete(ut);
  }

  browser.inUse = false;
  browser.userId = null;
  browser.sessionId = null;
  browser.clientId = null;
  browser.lastHeartbeat = null;
  activeConnections.delete(browser.id);
  syncBrowserToFirebase(browser);
}

// ─── Session cleanup (runs every 30s) ─────────────────────────────────────────

function cleanupSessions() {
  const now = Date.now();

  for (const browser of BROWSERS) {
    if (!browser.inUse) continue;

    const lastHb = browser.lastHeartbeat || browser.lastUsed || 0;
    if (lastHb && now - lastHb > SESSION_TIMEOUT_MS) {
      doReleaseBrowser(browser, `no heartbeat for ${Math.round((now - lastHb) / 1000)}s`);
      continue;
    }

    const conn = activeConnections.get(browser.id);
    if (!conn || conn.count <= 0) {
      const disconnectTime = conn?.lastDisconnect || browser.lastUsed || 0;
      const assignAge = now - (browser.lastUsed || 0);
      if (assignAge > 60000 && disconnectTime && now - disconnectTime > WS_PRESENCE_TIMEOUT_MS) {
        doReleaseBrowser(browser, `no active WebSocket for ${Math.round((now - disconnectTime) / 1000)}s`);
      }
    }
  }
}

setInterval(cleanupSessions, 30 * 1000);
setInterval(cleanupUrlTokens, 60 * 1000);

// ─── WebSocket connection tracking ───────────────────────────────────────────

function trackWsConnect(browserId) {
  const conn = activeConnections.get(browserId) || { count: 0, lastDisconnect: null };
  conn.count++;
  conn.lastDisconnect = null;
  activeConnections.set(browserId, conn);
  console.log(`[WS Track] Browser ${browserId} connections: ${conn.count}`);

  const browser = getBrowserById(browserId);
  if (browser && browser.inUse) browser.lastHeartbeat = Date.now();
}

function trackWsDisconnect(browserId) {
  const conn = activeConnections.get(browserId);
  if (conn) {
    conn.count = Math.max(0, conn.count - 1);
    if (conn.count === 0) conn.lastDisconnect = Date.now();
    console.log(`[WS Track] Browser ${browserId} disconnections, remaining: ${conn.count}`);
  }
}

// ─── Assign / status helpers ──────────────────────────────────────────────────

function assignBrowser(sessionId, clientId) {
  // Check if client already has a browser
  const existing = findBrowserByClientId(clientId);
  if (existing) {
    console.log(`[Assign] Client ${clientId} already has browser ${existing.id}, returning existing`);
    existing.lastHeartbeat = Date.now();
    sessions.set(sessionId, {
      browserId: existing.id,
      clientId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    });
    syncBrowserToFirebase(existing);
    let cookieToken = browserTokens.get(existing.id);
    if (!cookieToken) {
      cookieToken = generateSecureToken();
      browserTokens.set(existing.id, cookieToken);
      tokenToBrowser.set(cookieToken, existing.id);
    }
    const urlToken = createUrlToken(existing.id);
    return { browser: existing, existing: true, cookieToken, urlToken };
  }

  const browser = findAvailableBrowser();
  if (!browser) return null;

  browser.inUse = true;
  browser.lastUsed = Date.now();
  browser.lastHeartbeat = Date.now();
  browser.userId = sessionId;
  browser.sessionId = sessionId;
  browser.clientId = clientId;

  sessions.set(sessionId, {
    browserId: browser.id,
    clientId,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  });

  if (clientId) clientSessions.set(clientId, browser.id);
  activeConnections.set(browser.id, { count: 0, lastDisconnect: null });

  const { cookieToken, urlToken } = createSessionTokens(browser.id);
  console.log(`[Assign] Browser ${browser.id} NEW assigned to client ${clientId}, session ${sessionId}`);
  syncBrowserToFirebase(browser);

  return { browser, existing: false, cookieToken, urlToken };
}

function getStatus() {
  return {
    total: BROWSERS.length,
    available: BROWSERS.filter(b => !b.inUse).length,
    inUse: BROWSERS.filter(b => b.inUse).length,
    browsers: BROWSERS.map(b => ({ id: b.id, available: !b.inUse })),
  };
}

// ─── Static file serving ──────────────────────────────────────────────────────

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(data);
  });
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer({ keepAlive: true }, (req, res) => {
  if (req.socket && !req.socket._nebulaNoDelay) {
    req.socket.setNoDelay(true);
    req.socket._nebulaNoDelay = true;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Browser proxy routes: /browser/N/* ────────────────────────────────────
  const browserRoute = parseBrowserPath(url.pathname);
  if (browserRoute) {
    const browser = getBrowserById(browserRoute.browserId);
    if (!browser) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Browser not found');
      return;
    }

    // Access control — cookie or one-time URL token
    const cookies = parseCookies(req);
    let hasAccess = validateBrowserAccess(req, browser.id);

    if (!hasAccess && url.searchParams.has('token')) {
      const qToken = url.searchParams.get('token');
      const urlEntry = urlTokens.get(qToken);
      if (urlEntry && urlEntry.browserId === browser.id) {
        hasAccess = true;
        urlTokens.delete(qToken);
        res.setHeader('Set-Cookie', [
          `nebula_session=${urlEntry.cookieToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
          `nebula_browser=${browser.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
        ]);
        console.log(`[Token] Browser ${browser.id} one-time URL token consumed, cookie set`);
      }
    }

    if (!hasAccess) {
      console.log(`[Access Denied] Browser ${browser.id} - no valid session token`);
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end(`
        <html><head><title>Access Denied</title></head>
        <body style="background:#0d0620;color:#fff;font-family:'Inter',system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
          <div style="text-align:center;max-width:420px;">
            <h1 style="font-size:48px;margin-bottom:10px;">&#x1F6AB;</h1>
            <h2 style="background:linear-gradient(135deg,#a78bfa,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">Access Denied</h2>
            <p style="color:#a0a0b8;line-height:1.6;">This browser session belongs to another user.<br>Please request your own browser from the home page.</p>
            <a href="/" style="display:inline-block;margin-top:20px;padding:12px 32px;background:linear-gradient(135deg,#7c3aed,#a78bfa);color:#fff;text-decoration:none;border-radius:12px;font-weight:600;">Go to Home</a>
          </div>
        </body></html>
      `);
      return;
    }

    // Set tracking cookie
    if (!res.getHeader('Set-Cookie')) {
      res.setHeader('Set-Cookie', [`nebula_browser=${browser.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`]);
    }

    // Strip /browser/N prefix and ?token= before proxying to Neko
    const cleanSearch = new URLSearchParams(url.searchParams);
    cleanSearch.delete('token');
    const cleanQueryString = cleanSearch.toString();
    req.url = browserRoute.remainingPath + (cleanQueryString ? '?' + cleanQueryString : '');

    const target = `http://${browser.host}:${browser.port}`;
    if (!/\.(svg|png|jpg|jpeg|gif|woff2?|ttf|eot|css|js|ico)$/i.test(req.url)) {
      console.log(`[Proxy] ${url.pathname} -> ${target}${req.url}`);
    }

    proxy.web(req, res, { target }, (err) => {
      console.error(`[Proxy Error] Browser ${browser.id}: ${err.message}`);
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end('<html><body style="background:#0d0620;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;"><div style="text-align:center;"><div style="font-size:48px;margin-bottom:20px;">🌌</div><h1>Browser Starting Up...</h1><p style="color:#aaa;">Auto-retrying in <span id="cd">5</span>s</p><button onclick="location.reload()" style="padding:10px 24px;font-size:15px;cursor:pointer;background:#7c3aed;color:#fff;border:none;border-radius:8px;">Retry Now</button></div><script>var s=5,cd=document.getElementById("cd");setInterval(function(){s--;cd.textContent=s;if(s<=0)location.reload();},1000);</script></body></html>');
    });
    return;
  }

  // ── Landing page ──────────────────────────────────────────────────────────
  if (url.pathname === '/' || url.pathname === '/index.html') {
    serveFile(res, path.join(__dirname, 'index.html'), 'text/html');
    return;
  }

  // ── API: Status ───────────────────────────────────────────────────────────
  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getStatus()));
    return;
  }

  // ── API: Check existing session ───────────────────────────────────────────
  if (url.pathname === '/api/check-session') {
    const clientId = url.searchParams.get('clientId');
    if (!clientId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hasSession: false, error: 'Missing clientId' }));
      return;
    }

    const browser = findBrowserByClientId(clientId);
    if (browser) {
      const lastHb = browser.lastHeartbeat || browser.lastUsed || 0;
      const age = Date.now() - lastHb;
      if (age < SESSION_TIMEOUT_MS) {
        // Tunnel uses HTTPS, so always build URLs with https
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        let cookieToken = browserTokens.get(browser.id);
        if (!cookieToken) {
          cookieToken = generateSecureToken();
          browserTokens.set(browser.id, cookieToken);
          tokenToBrowser.set(cookieToken, browser.id);
        }
        const urlToken = createUrlToken(browser.id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          hasSession: true,
          browserId: browser.id,
          browserUrl: `${protocol}://${host}/browser/${browser.id}/?token=${urlToken}`,
          sessionAge: Math.round(age / 1000),
        }));
        return;
      }
      doReleaseBrowser(browser, 'stale session detected in check-session');
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hasSession: false }));
    return;
  }

  // ── API: Request browser ──────────────────────────────────────────────────
  if (url.pathname === '/api/request-browser' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        let clientId = parsed.clientId;

        if (!clientId || typeof clientId !== 'string' || clientId.length < 10) {
          const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
          const ua = (req.headers['user-agent'] || 'unknown').substring(0, 50);
          clientId = 'auto_' + Buffer.from(ip + '|' + ua).toString('base64').substring(0, 30);
          console.log(`[API] request-browser: no clientId provided, auto-generated: ${clientId}`);
        }

        console.log(`[API] request-browser clientId=${clientId}`);
        const sessionId = generateSessionId();
        const result = assignBrowser(sessionId, clientId);

        if (!result) {
          const inUseCount = BROWSERS.filter(b => b.inUse).length;
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: 'all_browsers_in_use',
            message: `All ${BROWSERS.length} browsers are currently in use.`,
            inUse: inUseCount,
            total: BROWSERS.length,
            suggestion: 'Sessions auto-expire after 5 minutes of inactivity. Please try again shortly.',
            retryAfterSeconds: 30,
          }));
          return;
        }

        const { browser, existing, cookieToken, urlToken } = result;
        // Tunnel uses HTTPS
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const absoluteBrowserUrl = `${protocol}://${host}/browser/${browser.id}/?token=${urlToken}`;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          sessionId: existing ? browser.sessionId : sessionId,
          browserUrl: absoluteBrowserUrl,
          browserId: browser.id,
          existing: !!existing,
          message: existing
            ? 'You already have a browser session open. Redirecting to your existing session.'
            : 'Browser assigned! Redirecting...',
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid request body.' }));
      }
    });
    return;
  }

  // ── API: Heartbeat ────────────────────────────────────────────────────────
  if (url.pathname === '/api/heartbeat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        let alive = false;

        if (parsed.browserId) {
          const browser = getBrowserById(parseInt(parsed.browserId, 10));
          if (browser && browser.inUse) {
            browser.lastHeartbeat = Date.now();
            for (const [, session] of sessions) {
              if (session.browserId === browser.id) { session.lastActivity = Date.now(); break; }
            }
            alive = true;
            if (Math.random() < 0.2) syncBrowserToFirebase(browser);
          }
        } else if (parsed.sessionId) {
          const session = sessions.get(parsed.sessionId);
          if (session) {
            session.lastActivity = Date.now();
            const browser = getBrowserById(session.browserId);
            if (browser) { browser.lastHeartbeat = Date.now(); alive = true; }
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: alive }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false }));
      }
    });
    return;
  }

  // ── API: Release ──────────────────────────────────────────────────────────
  if (url.pathname === '/api/release' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        let released = false;

        if (parsed.clientId) {
          const browser = findBrowserByClientId(parsed.clientId);
          if (browser) { doReleaseBrowser(browser, `explicit release by client ${parsed.clientId}`); released = true; }
        } else if (parsed.browserId) {
          const browser = getBrowserById(parseInt(parsed.browserId, 10));
          if (browser && browser.inUse) { doReleaseBrowser(browser, `explicit release by browserId ${parsed.browserId}`); released = true; }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: released }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false }));
      }
    });
    return;
  }

  // ── 404 ─────────────────────────────────────────────────────────────────
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// ─── WebSocket upgrade handling ───────────────────────────────────────────────
// Neko uses WebSocket for control signaling (ws://host:port/ws)

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const browserRoute = parseBrowserPath(url.pathname);

  console.log(`[WS Upgrade] Incoming: ${url.pathname}`);

  let browser = null;
  let targetPath = req.url;

  if (browserRoute) {
    browser = getBrowserById(browserRoute.browserId);
    targetPath = browserRoute.remainingPath + url.search;
  } else if (url.pathname === '/ws' || url.pathname.startsWith('/api/')) {
    browser = getBrowserFromCookie(req);
    targetPath = url.pathname + url.search;
  }

  if (!browser) {
    console.log(`[WS Upgrade] FAILED - No browser found for ${url.pathname}`);
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\nNo browser session found. Please reload the page.');
    socket.destroy();
    return;
  }

  // Access control for WebSocket
  if (!validateBrowserAccess(req, browser.id)) {
    console.log(`[WS Access Denied] Browser ${browser.id} - no valid session token`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\nAccess denied.');
    socket.destroy();
    return;
  }

  socket.on('error', (err) => {
    console.log(`[WS] Client socket error (browser ${browser.id}): ${err.code || err.message}`);
  });

  socket.on('close', () => {
    trackWsDisconnect(browser.id);
  });

  // Rewrite URL to strip /browser/N prefix
  req.url = targetPath;

  const target = `http://${browser.host}:${browser.port}`;
  console.log(`[WS Upgrade] Browser ${browser.id} -> ${target}${targetPath}`);

  trackWsConnect(browser.id);

  proxy.ws(req, socket, head, { target }, (err) => {
    console.error(`[WS Proxy Error] Browser ${browser.id}: ${err.message}`);
    if (!socket.destroyed) socket.destroy();
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3600;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   🌌 Nebula Browser Session Manager — Neko WebRTC Proxy      ║
║                                                              ║
║   Server running on http://localhost:${PORT}                   ║
║                                                              ║
║   Available browsers: ${BROWSERS.length}                                        ║
║   Session timeout: ${SESSION_TIMEOUT_MS / 60000} minutes                               ║
║                                                              ║
║   Routes:                                                    ║
║   • /                    - Landing page                      ║
║   • /api/status          - Browser availability              ║
║   • /api/request-browser - Get a browser slot                ║
║   • /api/check-session   - Check existing session            ║
║   • /api/heartbeat       - Keep session alive                ║
║   • /api/release         - Release session                   ║
║   • /browser/1/*         - Proxy to neko1 (port 3611)        ║
║   • /browser/2/*         - Proxy to neko2 (port 3612)        ║
║   • ... up to /browser/10/* (port 3630)                      ║
║                                                              ║
║   ONE TUNNEL to port ${PORT} handles everything!               ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);

  restoreStateFromFirebase().then(() => {
    updateBrowserSummary();
    console.log('[Startup] State restored, summary synced to Firebase');
  }).catch(err => {
    console.log('[Startup] Firebase restore failed:', err.message);
    updateBrowserSummary();
  });
});
