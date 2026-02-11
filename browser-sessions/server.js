/**
 * Nebula Browser Session Manager with Reverse Proxy
 * 
 * Single server that handles:
 * - Landing page and session management
 * - Reverse proxy to KasmVNC containers
 * - WebSocket proxying for VNC connections
 * 
 * Routes:
 * - /                    -> Landing page
 * - /api/*               -> Session management API
 * - /browser/1/*         -> Proxy to KasmVNC port 6901
 * - /browser/2/*         -> Proxy to KasmVNC port 6902
 * - etc.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const httpProxy = require('http-proxy');
const tls = require('tls');
const { spawn } = require('child_process');

// Firebase Admin SDK for Nebula Realtime Database sync
let db = null;
try {
  const admin = require('firebase-admin');
  const serviceAccountPath = path.join(__dirname, 'firebase-service-account.json');
  
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

// === Firebase State Persistence ===
// Firebase is the source of truth. State persists across server restarts.
// Every state change syncs to Firebase immediately.

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
          if (saved.clientId) {
            clientSessions.set(saved.clientId, browser.id);
          }
          // Generate new cookie token for restored session
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
      browsers: BROWSERS.map(b => ({
        id: b.id,
        available: !b.inUse,
      })),
    });
  } catch (err) {
    console.log(`[Firebase] Summary error: ${err.message}`);
  }
}

// Global error handlers to prevent server crashes
process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});

// KasmVNC Basic Auth credentials (base64 encoded "kasm_user:password")
const KASM_AUTH = 'Basic ' + Buffer.from('kasm_user:password').toString('base64');

// Custom HTTPS agent that ignores self-signed certs, low-latency
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  keepAliveMsecs: 10000,
});

// Create proxy server for HTTP and WebSocket
const proxy = httpProxy.createProxyServer({
  ws: true,
  changeOrigin: true,
  secure: false,
  agent: httpsAgent,
  headers: {
    Authorization: KASM_AUTH,
  },
  // SSL options for WebSocket connections to HTTPS targets
  ssl: {
    rejectUnauthorized: false,
  },
});

// Inject auth header before proxying
proxy.on('proxyReq', (proxyReq, req, res) => {
  proxyReq.setHeader('Authorization', KASM_AUTH);
  // Only log non-asset requests to reduce noise
  if (!/\.(svg|png|jpg|jpeg|gif|woff2?|ttf|eot|css|js|ico)$/i.test(proxyReq.path)) {
    console.log(`[HTTP] ${req.method} ${req.url} -> ${proxyReq.path}`);
  }
});

proxy.on('proxyReqWs', (proxyReq, req, socket, options, head) => {
  proxyReq.setHeader('Authorization', KASM_AUTH);
  console.log(`[WS Proxy] Upgrade request to ${options.target?.href || 'unknown'}${proxyReq.path}`);
  
  // Handle errors on the upstream request
  proxyReq.on('error', (err) => {
    console.log(`[WS Proxy] Upstream request error: ${err.code || err.message}`);
  });
});

// Handle proxy errors gracefully - auto-retry instead of dead page
proxy.on('error', (err, req, res) => {
  console.error('[Proxy Error]', err.message);
  if (res.writeHead) {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end(`
      <html>
        <head><title>Connecting...</title></head>
        <body style="background:#1a1a2e;color:#fff;font-family:Inter,system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
          <div style="text-align:center;">
            <div style="font-size:48px;margin-bottom:20px;">🌌</div>
            <h1 style="margin:0 0 10px;">Browser Starting Up...</h1>
            <p style="color:#aaa;margin:0 0 20px;">The container is restarting. Auto-retrying in <span id="cd">5</span>s</p>
            <div style="width:200px;height:4px;background:#333;border-radius:2px;margin:0 auto 20px;">
              <div id="bar" style="width:0%;height:100%;background:linear-gradient(90deg,#7c3aed,#a855f7);border-radius:2px;transition:width 0.5s;"></div>
            </div>
            <button onclick="location.reload()" style="padding:10px 24px;font-size:15px;cursor:pointer;background:#7c3aed;color:#fff;border:none;border-radius:8px;">Retry Now</button>
          </div>
          <script>
            var s=5,b=document.getElementById('bar'),cd=document.getElementById('cd');
            var i=setInterval(function(){s--;cd.textContent=s;b.style.width=((5-s)/5*100)+'%';if(s<=0){clearInterval(i);location.reload();}},1000);
          </script>
        </body>
      </html>
    `);
  }
});

// Handle open WebSocket connections
proxy.on('open', (proxySocket) => {
  console.log('[WS Proxy] Connection opened to upstream');
  proxySocket.on('error', (err) => {
    console.log(`[WS Proxy] Upstream socket error: ${err.code || err.message}`);
  });
});

// Handle close event
proxy.on('close', (res, socket, head) => {
  console.log('[WS Proxy] Connection closed');
});

// Handle econnreset and other socket errors on the client side
proxy.on('econnreset', (err, req, res) => {
  console.log('[Proxy] Connection reset by peer');
});

// Browser pool configuration (port = VNC, audioPort = JSMpeg audio WebSocket)
const BROWSERS = [
  { id: 1, port: 6901, audioPort: 4901, host: 'localhost', inUse: false, lastUsed: null, lastHeartbeat: null, userId: null, sessionId: null, clientId: null },
  { id: 2, port: 6902, audioPort: 4902, host: 'localhost', inUse: false, lastUsed: null, lastHeartbeat: null, userId: null, sessionId: null, clientId: null },
  { id: 3, port: 6903, audioPort: 4903, host: 'localhost', inUse: false, lastUsed: null, lastHeartbeat: null, userId: null, sessionId: null, clientId: null },
  { id: 4, port: 6904, audioPort: 4904, host: 'localhost', inUse: false, lastUsed: null, lastHeartbeat: null, userId: null, sessionId: null, clientId: null },
  { id: 5, port: 6905, audioPort: 4905, host: 'localhost', inUse: false, lastUsed: null, lastHeartbeat: null, userId: null, sessionId: null, clientId: null },
  { id: 6, port: 6906, audioPort: 4906, host: 'localhost', inUse: false, lastUsed: null, lastHeartbeat: null, userId: null, sessionId: null, clientId: null },
  { id: 7, port: 6907, audioPort: 4907, host: 'localhost', inUse: false, lastUsed: null, lastHeartbeat: null, userId: null, sessionId: null, clientId: null },
  { id: 8, port: 6908, audioPort: 4908, host: 'localhost', inUse: false, lastUsed: null, lastHeartbeat: null, userId: null, sessionId: null, clientId: null },
  { id: 9, port: 6909, audioPort: 4909, host: 'localhost', inUse: false, lastUsed: null, lastHeartbeat: null, userId: null, sessionId: null, clientId: null },
  { id: 10, port: 6910, audioPort: 4910, host: 'localhost', inUse: false, lastUsed: null, lastHeartbeat: null, userId: null, sessionId: null, clientId: null },
];

// Map browser ID to Docker container name
function getContainerName(browserId) {
  return browserId === 1 ? 'browser' : `browser${browserId}`;
}

// Create a WebSocket binary frame (opcode 0x02)
function makeWsFrame(data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = [];
  header.push(0x82); // FIN + binary
  if (payload.length < 126) {
    header.push(payload.length);
  } else if (payload.length < 65536) {
    header.push(126, (payload.length >> 8) & 0xFF, payload.length & 0xFF);
  } else {
    header.push(127);
    for (let i = 7; i >= 0; i--) header.push((payload.length >> (i * 8)) & 0xFF);
  }
  return Buffer.concat([Buffer.from(header), payload]);
}

// Compute Sec-WebSocket-Accept for upgrade response
function computeWsAccept(key) {
  const crypto = require('crypto');
  return crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

// Active audio processes per browser (so we don't leak)
const audioProcesses = new Map();

// Session timeout (5 min no heartbeat = released)
// WS presence timeout (2 min no active WS after disconnect = released)
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const WS_PRESENCE_TIMEOUT_MS = 2 * 60 * 1000;

// Track active sessions: sessionId -> { browserId, clientId, createdAt, lastActivity }
const sessions = new Map();

// Track clientId -> browserId (prevents duplicate browser claims)
const clientSessions = new Map();

// Track active WebSocket connections per browser: browserId -> { count, lastDisconnect }
const activeConnections = new Map();

// === SESSION TOKEN ACCESS CONTROL ===
// Two-token system to prevent URL sharing:
// 1. "cookie token" (long-lived) — stored in HttpOnly cookie, can't be read/shared by users
// 2. "URL token" (one-time-use) — in the ?token= query param, consumed on first access
//
// Flow: API gives urlToken → user opens URL → server validates & consumes urlToken,
//       sets cookieToken as HttpOnly cookie → all subsequent requests use cookie.
//       Sharing the URL with someone else fails because urlToken is already consumed.
const browserTokens = new Map();   // browserId -> cookieToken
const tokenToBrowser = new Map();  // cookieToken -> browserId
const urlTokens = new Map();       // urlToken -> { browserId, cookieToken, createdAt }

function generateSecureToken() {
  const crypto = require('crypto');
  return crypto.randomBytes(32).toString('hex');
}

// Create both tokens for a browser session. Returns { cookieToken, urlToken }
function createSessionTokens(browserId) {
  // Clear any old cookie token
  const oldCookieToken = browserTokens.get(browserId);
  if (oldCookieToken) tokenToBrowser.delete(oldCookieToken);
  
  const cookieToken = generateSecureToken();
  const urlToken = generateSecureToken();
  
  browserTokens.set(browserId, cookieToken);
  tokenToBrowser.set(cookieToken, browserId);
  urlTokens.set(urlToken, { browserId, cookieToken, createdAt: Date.now() });
  
  return { cookieToken, urlToken };
}

// Generate a new one-time URL token for an existing session (e.g. check-session)
function createUrlToken(browserId) {
  const cookieToken = browserTokens.get(browserId);
  if (!cookieToken) return null;
  const urlToken = generateSecureToken();
  urlTokens.set(urlToken, { browserId, cookieToken, createdAt: Date.now() });
  return urlToken;
}

// Validate cookie-based access (for ongoing requests after initial access)
function validateBrowserAccess(req, browserId) {
  const cookies = parseCookies(req);
  const token = cookies.nebula_session;
  if (!token) return false;
  const allowedBrowserId = tokenToBrowser.get(token);
  return allowedBrowserId === browserId;
}

// Clean up expired URL tokens (older than 5 minutes)
function cleanupUrlTokens() {
  const now = Date.now();
  for (const [token, entry] of urlTokens) {
    if (now - entry.createdAt > 5 * 60 * 1000) {
      urlTokens.delete(token);
    }
  }
}

// Generate simple session ID
function generateSessionId() {
  return 'sess_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

// === Release a browser slot (internal helper) ===
function doReleaseBrowser(browser, reason) {
  if (!browser || !browser.inUse) return;
  
  console.log(`[Release] Browser ${browser.id} released (${reason})`);
  
  // Clean session map
  for (const [sessionId, session] of sessions) {
    if (session.browserId === browser.id) {
      sessions.delete(sessionId);
      break;
    }
  }
  
  // Clean client mapping
  if (browser.clientId) {
    clientSessions.delete(browser.clientId);
  }
  
  // Clean session tokens
  const oldToken = browserTokens.get(browser.id);
  if (oldToken) {
    tokenToBrowser.delete(oldToken);
    browserTokens.delete(browser.id);
  }
  // Clean any outstanding URL tokens for this browser
  for (const [ut, entry] of urlTokens) {
    if (entry.browserId === browser.id) urlTokens.delete(ut);
  }
  console.log(`[Token] Cleared all tokens for browser ${browser.id}`);
  
  browser.inUse = false;
  browser.userId = null;
  browser.sessionId = null;
  browser.clientId = null;
  browser.lastHeartbeat = null;
  
  activeConnections.delete(browser.id);
  syncBrowserToFirebase(browser);
}

// === Cleanup stale sessions ===
function cleanupSessions() {
  const now = Date.now();
  
  for (const browser of BROWSERS) {
    if (!browser.inUse) continue;
    
    // 1. No heartbeat for SESSION_TIMEOUT_MS → release
    const lastHb = browser.lastHeartbeat || browser.lastUsed || 0;
    if (lastHb && now - lastHb > SESSION_TIMEOUT_MS) {
      doReleaseBrowser(browser, `no heartbeat for ${Math.round((now - lastHb) / 1000)}s`);
      continue;
    }
    
    // 2. No active WebSocket and no WS for WS_PRESENCE_TIMEOUT_MS → release
    const conn = activeConnections.get(browser.id);
    if (!conn || conn.count <= 0) {
      const disconnectTime = conn?.lastDisconnect || browser.lastUsed || 0;
      // Only use WS presence check if browser has been assigned for > 60s
      // (give time for initial WS connection)
      const assignAge = now - (browser.lastUsed || 0);
      if (assignAge > 60000 && disconnectTime && now - disconnectTime > WS_PRESENCE_TIMEOUT_MS) {
        doReleaseBrowser(browser, `no active WebSocket for ${Math.round((now - disconnectTime) / 1000)}s`);
        continue;
      }
    }
  }
}

// Run cleanup every 30 seconds
setInterval(cleanupSessions, 30 * 1000);
setInterval(cleanupUrlTokens, 60 * 1000); // Clean expired one-time URL tokens

// Track WebSocket connection open for a browser
function trackWsConnect(browserId) {
  const conn = activeConnections.get(browserId) || { count: 0, lastDisconnect: null };
  conn.count++;
  conn.lastDisconnect = null;
  activeConnections.set(browserId, conn);
  console.log(`[WS Track] Browser ${browserId} connections: ${conn.count}`);
  
  // Also refresh heartbeat on WS connect
  const browser = getBrowserById(browserId);
  if (browser && browser.inUse) {
    browser.lastHeartbeat = Date.now();
  }
}

// Track WebSocket connection close for a browser
function trackWsDisconnect(browserId) {
  const conn = activeConnections.get(browserId);
  if (conn) {
    conn.count = Math.max(0, conn.count - 1);
    if (conn.count === 0) {
      conn.lastDisconnect = Date.now();
    }
    console.log(`[WS Track] Browser ${browserId} disconnections, remaining: ${conn.count}`);
  }
}

// Find available browser
function findAvailableBrowser() {
  return BROWSERS.find(b => !b.inUse);
}

// Find browser by clientId
function findBrowserByClientId(clientId) {
  if (!clientId) return null;
  const browserId = clientSessions.get(clientId);
  if (!browserId) return null;
  const browser = getBrowserById(browserId);
  if (browser && browser.inUse && browser.clientId === clientId) {
    return browser;
  }
  // Stale mapping
  clientSessions.delete(clientId);
  return null;
}

// Assign browser to user. If clientId already has one, return it.
function assignBrowser(sessionId, clientId) {
  // Check if client already has a browser
  const existing = findBrowserByClientId(clientId);
  if (existing) {
    console.log(`[Assign] Client ${clientId} already has browser ${existing.id}, returning existing`);
    existing.lastHeartbeat = Date.now();
    // Update session map with new sessionId
    sessions.set(sessionId, {
      browserId: existing.id,
      clientId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    });
    syncBrowserToFirebase(existing);
    // Ensure cookie token exists
    let cookieToken = browserTokens.get(existing.id);
    if (!cookieToken) {
      cookieToken = generateSecureToken();
      browserTokens.set(existing.id, cookieToken);
      tokenToBrowser.set(cookieToken, existing.id);
      console.log(`[Token] Regenerated cookie token for existing browser ${existing.id}`);
    }
    // Generate a fresh one-time URL token
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
  
  if (clientId) {
    clientSessions.set(clientId, browser.id);
  }
  
  activeConnections.set(browser.id, { count: 0, lastDisconnect: null });
  
  // Generate session tokens (cookie token + one-time URL token)
  const { cookieToken, urlToken } = createSessionTokens(browser.id);
  
  console.log(`[Assign] Browser ${browser.id} NEW assigned to client ${clientId}, session ${sessionId}`);
  syncBrowserToFirebase(browser);
  
  return { browser, existing: false, cookieToken, urlToken };
}

// Get browser status
function getStatus() {
  return {
    total: BROWSERS.length,
    available: BROWSERS.filter(b => !b.inUse).length,
    inUse: BROWSERS.filter(b => b.inUse).length,
    browsers: BROWSERS.map(b => ({
      id: b.id,
      available: !b.inUse,
    })),
  };
}

// Serve static files
function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// Helper to get browser by ID
function getBrowserById(id) {
  return BROWSERS.find(b => b.id === id);
}

// Check if path is a browser proxy route
function parseBrowserPath(pathname) {
  const match = pathname.match(/^\/browser\/(\d+)(\/.*)?$/);
  if (match) {
    const browserId = parseInt(match[1], 10);
    const remainingPath = match[2] || '/';
    return { browserId, remainingPath };
  }
  return null;
}

// Parse cookies from request
function parseCookies(req) {
  const cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      if (name && value) cookies[name] = value;
    });
  }
  return cookies;
}

// Get browser ID from cookie
function getBrowserFromCookie(req) {
  const cookies = parseCookies(req);
  const browserId = parseInt(cookies.nebula_browser, 10);
  if (browserId && browserId >= 1 && browserId <= BROWSERS.length) {
    return getBrowserById(browserId);
  }
  return null;
}

// Create server with low-latency settings
const server = http.createServer({ keepAlive: true }, (req, res) => {
  // Disable Nagle on incoming connection for interactive responsiveness
  if (req.socket && !req.socket._nebulaNoDelay) {
    req.socket.setNoDelay(true);
    req.socket._nebulaNoDelay = true;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  // Browser proxy routes: /browser/1/*, /browser/2/*, etc.
  const browserRoute = parseBrowserPath(url.pathname);
  if (browserRoute) {
    const browser = getBrowserById(browserRoute.browserId);
    if (!browser) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Browser not found');
      return;
    }
    
    // === ACCESS CONTROL: verify session token ===
    // 1. Check cookie first (returning user with valid session)
    const cookies = parseCookies(req);
    let hasAccess = validateBrowserAccess(req, browser.id);
    
    // 2. If no cookie, check one-time URL token (first visit from frontend redirect)
    if (!hasAccess && url.searchParams.has('token')) {
      const qToken = url.searchParams.get('token');
      const urlEntry = urlTokens.get(qToken);
      if (urlEntry && urlEntry.browserId === browser.id) {
        hasAccess = true;
        // CONSUME the URL token — it can never be used again
        urlTokens.delete(qToken);
        // Set the COOKIE token so subsequent requests (sub-resources, WebSocket) work
        res.setHeader('Set-Cookie', [
          `nebula_session=${urlEntry.cookieToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
          `nebula_browser=${browser.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
        ]);
        console.log(`[Token] Browser ${browser.id} one-time URL token consumed, cookie set`);
      } else {
        console.log(`[Token] Browser ${browser.id} URL token invalid or already used`);
      }
    }
    
    if (!hasAccess) {
      console.log(`[Access Denied] Browser ${browser.id} - no valid session token (cookie: ${cookies.nebula_session ? 'present' : 'missing'})`);
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
        <head><title>Access Denied</title></head>
        <body style=\"background:#0d0620;color:#fff;font-family:'Inter',system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;\">
          <div style=\"text-align:center;max-width:420px;\">
            <h1 style=\"font-size:48px;margin-bottom:10px;\">&#x1F6AB;</h1>
            <h2 style=\"background:linear-gradient(135deg,#a78bfa,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent;\">Access Denied</h2>
            <p style=\"color:#a0a0b8;line-height:1.6;\">This browser session belongs to another user.<br>Please request your own browser from the home page.</p>
            <a href=\"/\" style=\"display:inline-block;margin-top:20px;padding:12px 32px;background:linear-gradient(135deg,#7c3aed,#a78bfa);color:#fff;text-decoration:none;border-radius:12px;font-weight:600;transition:transform 0.2s;\">Go to Home</a>
          </div>
        </body>
        </html>
      `);
      return;
    }
    
    // Set cookie to track which browser this user is using (for WebSocket routing)
    if (!res.getHeader('Set-Cookie')) {
      res.setHeader('Set-Cookie', [
        `nebula_browser=${browser.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
      ]);
    }
    
    // Rewrite the URL to remove /browser/N prefix
    // Also strip ?token= param so KasmVNC doesn't see it
    const cleanSearch = new URLSearchParams(url.searchParams);
    cleanSearch.delete('token');
    const cleanQueryString = cleanSearch.toString();
    req.url = browserRoute.remainingPath + (cleanQueryString ? '?' + cleanQueryString : '');
    
    // Proxy to the KasmVNC container (HTTPS - self-signed cert)
    const target = `https://${browser.host}:${browser.port}`;
    // Only log non-asset requests
    if (!/\.(svg|png|jpg|jpeg|gif|woff2?|ttf|eot|css|js|ico|oga|mp3|wav)$/i.test(req.url)) {
      console.log(`[Proxy] ${url.pathname} -> ${target}${req.url}`);
    }
    
    // For the main KasmVNC page, inject audio player + touchscreen keyboard helper
    if (browserRoute.remainingPath === '/' || browserRoute.remainingPath === '/index.html') {
      // Fetch the KasmVNC page and inject our additions
      // Force no compression so we can read/modify the HTML body
      const injectHeaders = { ...req.headers, host: `${browser.host}:${browser.port}`, Authorization: KASM_AUTH };
      injectHeaders['accept-encoding'] = 'identity';
      delete injectHeaders['if-none-match'];
      delete injectHeaders['if-modified-since'];
      const proxyReq = https.request(`${target}${req.url}`, {
        method: req.method,
        headers: injectHeaders,
        rejectUnauthorized: false,
      }, (proxyRes) => {
        // If 304 Not Modified, just pass it through
        if (proxyRes.statusCode === 304) {
          res.writeHead(304, proxyRes.headers);
          res.end();
          return;
        }
        console.log(`[Inject] KasmVNC response: status=${proxyRes.statusCode}, content-type=${proxyRes.headers['content-type']}, encoding=${proxyRes.headers['content-encoding'] || 'none'}, length=${proxyRes.headers['content-length'] || 'chunked'}`);
        
        const chunks = [];
        proxyRes.on('data', chunk => chunks.push(chunk));
        proxyRes.on('end', () => {
          let body = Buffer.concat(chunks).toString('utf-8');
          console.log(`[Inject] Body received: ${body.length} chars, has </body>: ${body.includes('</body>')}, has </html>: ${body.includes('</html>')}, has </script>: ${body.includes('</script>')}`);
          
          // If body is empty or not HTML, just pass through
          if (!body || body.length < 100 || !body.includes('<')) {
            const headers = { ...proxyRes.headers };
            res.writeHead(proxyRes.statusCode, headers);
            res.end(body);
            return;
          }
          // Build the audio WebSocket URL dynamically
          const audioInjectScript = `
<script>
// === Nebula Browser Enhancements ===
(function() {

  // --- 1. STYLE KASM KEYBOARD BUTTON (KEEP VISIBLE) ---
  var kasmKbStyle = document.createElement('style');
  kasmKbStyle.textContent = [
    '#noVNC_keyboard_control { z-index: 100000 !important; }',
    '#noVNC_keyboardinput { position: fixed !important; top: -9999px !important; left: -9999px !important; opacity: 0 !important; }',
    '@keyframes nebulaArrowBounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-8px)} }',
    '@keyframes nebulaPulse { 0%,100%{box-shadow:0 0 0 0 rgba(147,51,234,0.6)} 50%{box-shadow:0 0 0 12px rgba(147,51,234,0)} }',
    '@keyframes nebulaFadeIn { from{opacity:0;transform:translateY(15px)} to{opacity:1;transform:translateY(0)} }',
    '@keyframes nebulaOverlayFadeIn { from{opacity:0} to{opacity:1} }'
  ].join('\\n');
  document.head.appendChild(kasmKbStyle);

  // --- 2. FIX SCROLLING ON iPAD / TOUCH DEVICES ---
  // Two-finger swipe = SCROLL (dispatches wheel events to VNC)
  // Single finger = PASSTHROUGH (KasmVNC handles tap/click/drag)
  var scrollFix = document.createElement('style');
  scrollFix.textContent = [
    'html, body { overflow: hidden !important; overscroll-behavior: none !important; width: 100% !important; height: 100% !important; margin: 0 !important; padding: 0 !important; -webkit-overflow-scrolling: auto !important; }',
    '#noVNC_container, #noVNC_canvas { touch-action: none !important; }',
    '#noVNC_screen { touch-action: none !important; }'
  ].join('\\n');
  document.head.appendChild(scrollFix);

  // Prevent page scroll when KasmVNC keyboard input gets focus
  if ('virtualKeyboard' in navigator) {
    navigator.virtualKeyboard.overlaysContent = true;
  }
  document.addEventListener('focusin', function(e) {
    if (e.target && e.target.id === 'noVNC_keyboardinput') {
      setTimeout(function() { window.scrollTo(0, 0); }, 50);
      setTimeout(function() { window.scrollTo(0, 0); }, 150);
      setTimeout(function() { window.scrollTo(0, 0); }, 300);
      setTimeout(function() { window.scrollTo(0, 0); }, 600);
    }
  });

  // Prevent page scroll outside VNC canvas
  document.addEventListener('touchmove', function(e) {
    var t = e.target;
    while (t) {
      if (t.id === 'noVNC_canvas' || t.id === 'noVNC_screen' || t.id === 'noVNC_container') return;
      t = t.parentElement;
    }
    if (e.touches.length > 0) e.preventDefault();
  }, { passive: false });

  // --- TWO-FINGER SWIPE → SCROLL on VNC canvas ---
  (function() {
    var isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (!isTouchDevice) return;

    var twoFingerState = null;
    var momentumId = null;

    function getCanvas() {
      return document.getElementById('noVNC_canvas');
    }

    function isOnCanvas(el) {
      while (el) {
        if (el.id === 'noVNC_canvas' || el.id === 'noVNC_screen' || el.id === 'noVNC_container') return true;
        el = el.parentElement;
      }
      return false;
    }

    function sendWheel(dy, cx, cy) {
      var canvas = getCanvas();
      if (!canvas) return;
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaX: 0, deltaY: dy, deltaMode: 0,
        clientX: cx, clientY: cy,
        bubbles: true, cancelable: true
      }));
    }

    // Two-finger scroll detection
    document.addEventListener('touchstart', function(e) {
      // Cancel any momentum animation
      if (momentumId) { cancelAnimationFrame(momentumId); momentumId = null; }

      if (e.touches.length === 2 && isOnCanvas(e.touches[0].target)) {
        var midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        var midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        twoFingerState = { lastY: midY, lastX: midX, midX: midX, midY: midY, velocityY: 0, lastTime: Date.now() };
      } else {
        twoFingerState = null;
      }
    }, { passive: true });

    document.addEventListener('touchmove', function(e) {
      if (e.touches.length === 2 && twoFingerState) {
        e.preventDefault();
        e.stopPropagation();

        var midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        var midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        var deltaY = twoFingerState.lastY - midY; // positive = scroll down
        var now = Date.now();
        var dt = Math.max(now - twoFingerState.lastTime, 1);

        // Track velocity for momentum
        twoFingerState.velocityY = deltaY / dt * 16; // per-frame velocity
        twoFingerState.lastTime = now;
        twoFingerState.lastY = midY;
        twoFingerState.lastX = midX;
        twoFingerState.midX = midX;
        twoFingerState.midY = midY;

        // Direct scroll — amplify 3x for responsive feel
        if (Math.abs(deltaY) > 0.5) {
          sendWheel(deltaY * 3, midX, midY);
        }
      } else if (e.touches.length !== 2) {
        twoFingerState = null;
      }
    }, { passive: false, capture: true });

    document.addEventListener('touchend', function(e) {
      if (twoFingerState && Math.abs(twoFingerState.velocityY) > 0.5) {
        // Momentum scrolling — decelerate over time
        var vel = twoFingerState.velocityY;
        var cx = twoFingerState.midX;
        var cy = twoFingerState.midY;
        twoFingerState = null;

        function momentumStep() {
          vel *= 0.92; // friction
          if (Math.abs(vel) < 0.3) return;
          sendWheel(vel * 3, cx, cy);
          momentumId = requestAnimationFrame(momentumStep);
        }
        momentumId = requestAnimationFrame(momentumStep);
      } else {
        twoFingerState = null;
      }
    }, { passive: true });
  })();

  // --- 3. SET CLIENT-SIDE QUALITY (GOOD QUALITY + SMOOTH) ---
  function applyMaxQuality() {
    var isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    var qualitySettings = {
      'noVNC_setting_dynamic_quality_min': isMobile ? 4 : 6,
      'noVNC_setting_dynamic_quality_max': 9,
      'noVNC_setting_treat_lossless': 7,
      'noVNC_setting_jpeg_video_quality': isMobile ? 5 : 7,
      'noVNC_setting_webp_video_quality': isMobile ? 5 : 7,
      'noVNC_setting_video_area': 65,
      'noVNC_setting_framerate': 30,
      'noVNC_setting_max_video_resolution_x': isMobile ? 1280 : 1920,
      'noVNC_setting_max_video_resolution_y': isMobile ? 720 : 1080,
      'noVNC_setting_video_scaling': isMobile ? 1 : 0
    };
    var applied = 0;
    for (var id in qualitySettings) {
      var el = document.getElementById(id);
      if (el) {
        el.value = qualitySettings[id];
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        var out = document.getElementById(id + '_output');
        if (out) out.value = qualitySettings[id];
        applied++;
      }
    }
    var webpEl = document.getElementById('noVNC_setting_enable_webp');
    if (webpEl && !webpEl.checked) { webpEl.click(); }
    return applied;
  }
  setTimeout(function() {
    var n = applyMaxQuality();
    console.log('[Nebula] Quality settings applied (' + n + ' controls found)');
  }, 300);
  setTimeout(applyMaxQuality, 1000);
  setTimeout(applyMaxQuality, 2500);

  // --- 4. AUDIO PLAYER (JSMpeg) — with iOS user-gesture unlock ---
  var s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/gh/phoboslab/jsmpeg@master/jsmpeg.min.js';
  s.onload = function() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var audioWsUrl = proto + '//' + location.host + '/browser/${browser.id}/audio';
    console.log('[Nebula Audio] Connecting to:', audioWsUrl);

    var canvas = document.createElement('canvas');
    canvas.width = 1; canvas.height = 1;
    canvas.style.cssText = 'position:fixed;bottom:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(canvas);

    function startAudioPlayer() {
      try {
        var player = new JSMpeg.Player(audioWsUrl, {
          canvas: canvas,
          audio: true,
          video: false,
          autoplay: true,
          loop: false,
          disableGl: true,
          maxAudioLag: 0.3,
          audioBufferSize: 128 * 1024,
          videoBufferSize: 0,
          streaming: true,
          reconnectInterval: 0
        });
        console.log('[Nebula Audio] Player initialized');
        window._nebulaAudioPlayer = player;

        // Audio toggle button
        var audioBtn = document.createElement('div');
        audioBtn.id = 'nebula-audio-btn';
        audioBtn.innerHTML = '\\u{1F50A}';
        audioBtn.title = 'Toggle Audio';
        audioBtn.style.cssText = 'position:fixed;bottom:15px;left:15px;z-index:100000;width:40px;height:40px;background:rgba(0,0,0,0.6);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:20px;border:2px solid rgba(255,255,255,0.3);transition:all 0.3s;-webkit-tap-highlight-color:transparent;';
        var muted = false;
        audioBtn.onclick = function() {
          muted = !muted;
          player.volume = muted ? 0 : 1;
          audioBtn.innerHTML = muted ? '\\u{1F507}' : '\\u{1F50A}';
          audioBtn.style.opacity = muted ? '0.5' : '1';
        };
        document.body.appendChild(audioBtn);
      } catch(e) { console.warn('[Nebula Audio] Init failed:', e); }
    }

    // All touch devices (iPad, iPhone, Android) need a user gesture for AudioContext
    // Desktop browsers behind Cloudflare tunnel may also need it
    var isTouchDev = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (isTouchDev) {
      // Show a prominent "Tap to enable audio" button
      var audioOverlay = document.createElement('div');
      audioOverlay.id = 'nebula-audio-unlock';
      audioOverlay.style.cssText = 'position:fixed;bottom:70px;left:50%;transform:translateX(-50%);z-index:100001;background:rgba(147,51,234,0.95);color:#fff;padding:14px 28px;border-radius:30px;font-size:16px;font-weight:600;font-family:Inter,system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,0.4);-webkit-tap-highlight-color:transparent;animation:nebulaFadeIn 0.5s ease;display:flex;align-items:center;gap:10px;';
      audioOverlay.innerHTML = '\\u{1F50A} <b>Tap here to enable audio</b>';
      document.body.appendChild(audioOverlay);

      function unlockAndStart() {
        if (!document.getElementById('nebula-audio-unlock')) return;
        audioOverlay.remove();
        // Create and resume an AudioContext with user gesture
        try {
          var ctx = new (window.AudioContext || window.webkitAudioContext)();
          ctx.resume().then(function() {
            console.log('[Nebula Audio] AudioContext unlocked via user gesture');
            startAudioPlayer();
          }).catch(function() { startAudioPlayer(); });
        } catch(e) { startAudioPlayer(); }
      }

      audioOverlay.addEventListener('click', unlockAndStart, { once: true });
      audioOverlay.addEventListener('touchend', function(e) { e.preventDefault(); unlockAndStart(); }, { once: true });

      // Auto-dismiss after 30 seconds if user ignores it, start audio anyway
      setTimeout(function() {
        if (document.getElementById('nebula-audio-unlock')) {
          unlockAndStart();
        }
      }, 30000);
    } else {
      // Desktop — just start immediately
      startAudioPlayer();
    }
  };
  s.onerror = function() { console.warn('[Nebula Audio] Failed to load JSMpeg library'); };
  document.head.appendChild(s);

  // --- 5. SESSION HEARTBEAT ---
  setInterval(function() {
    fetch('/api/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browserId: ${browser.id} })
    }).catch(function(e) { console.warn('[Nebula HB] Error:', e.message); });
  }, 25000);
  fetch('/api/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ browserId: ${browser.id} })
  }).catch(function() {});

  // --- 6. TOOLTIPS (KEYBOARD + TWO-FINGER SCROLL) ---
  (function() {
    var isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

    // ---- 6A. FULLSCREEN "SCROLL WITH TWO FINGERS" TOOLTIP (touch only) ----
    if (isTouchDevice) {
      (function() {
        try { if (sessionStorage.getItem('nebula_scroll_tip_done')) return; } catch(e) {}

        var overlay = document.createElement('div');
        overlay.id = 'nebula-scroll-tip';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:200000;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;justify-content:center;align-items:center;animation:nebulaOverlayFadeIn 0.3s ease;-webkit-tap-highlight-color:transparent;';

        var iconDiv = document.createElement('div');
        iconDiv.style.cssText = 'font-size:80px;margin-bottom:20px;';
        iconDiv.textContent = '\\u{1F590}';

        var titleDiv = document.createElement('div');
        titleDiv.style.cssText = 'color:#fff;font-size:28px;font-weight:700;font-family:Inter,system-ui,-apple-system,sans-serif;margin-bottom:12px;text-align:center;';
        titleDiv.textContent = 'Scroll with Two Fingers';

        var descDiv = document.createElement('div');
        descDiv.style.cssText = 'color:rgba(255,255,255,0.7);font-size:16px;font-family:Inter,system-ui,-apple-system,sans-serif;text-align:center;max-width:300px;line-height:1.5;margin-bottom:30px;';
        descDiv.textContent = 'Use two fingers to swipe up and down to scroll. One finger taps and drags like a mouse.';

        var gotItBtn = document.createElement('div');
        gotItBtn.style.cssText = 'background:#7c3aed;color:#fff;padding:14px 40px;border-radius:12px;font-size:18px;font-weight:600;font-family:Inter,system-ui,-apple-system,sans-serif;cursor:pointer;box-shadow:0 4px 15px rgba(124,58,237,0.4);-webkit-tap-highlight-color:transparent;';
        gotItBtn.textContent = 'Got it!';

        overlay.appendChild(iconDiv);
        overlay.appendChild(titleDiv);
        overlay.appendChild(descDiv);
        overlay.appendChild(gotItBtn);
        document.body.appendChild(overlay);

        function dismissScroll() {
          overlay.style.transition = 'opacity 0.4s';
          overlay.style.opacity = '0';
          setTimeout(function() { overlay.remove(); }, 400);
          try { sessionStorage.setItem('nebula_scroll_tip_done', '1'); } catch(e) {}
        }

        gotItBtn.addEventListener('click', dismissScroll);
        overlay.addEventListener('click', function(e) { if (e.target === overlay) dismissScroll(); });
        setTimeout(dismissScroll, 8000);
      })();
    } // end scroll tip touch-only

    // ---- 6B. KEYBOARD TOOLTIP — ALL DEVICES ----
    function showKeyboardTip() {
      var sidebarHandle = document.getElementById('noVNC_control_bar_handle');
      var keysBtn = document.getElementById('noVNC_toggle_extra_keys_button');

      if (!sidebarHandle || !keysBtn) {
        setTimeout(showKeyboardTip, 500);
        return;
      }

      try { if (sessionStorage.getItem('nebula_kb_tip_done')) return; } catch(e) {}

      var overlay = document.createElement('div');
      overlay.id = 'nebula-kb-tip';
      overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:200000;background:rgba(0,0,0,0.88);display:flex;flex-direction:column;justify-content:center;align-items:center;animation:nebulaOverlayFadeIn 0.3s ease;-webkit-tap-highlight-color:transparent;padding:20px;box-sizing:border-box;';

      var card = document.createElement('div');
      card.style.cssText = 'background:rgba(30,30,50,0.95);border:1px solid rgba(147,51,234,0.4);border-radius:20px;padding:28px 24px;max-width:320px;width:100%;box-shadow:0 8px 40px rgba(0,0,0,0.5);';

      var deviceName = isTouchDevice ? 'iPad keyboard' : 'on-screen keyboard';
      card.innerHTML = '<div style="text-align:center;margin-bottom:20px;"><div style="font-size:44px;margin-bottom:10px;">\u2328\uFE0F</div><div style="color:#fff;font-size:22px;font-weight:700;font-family:Inter,system-ui,sans-serif;">How to Type</div></div>' +
        '<div style="color:#fff;font-family:Inter,system-ui,sans-serif;font-size:15px;line-height:1.8;">' +
        '<div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:16px;"><div style="background:#7c3aed;color:#fff;min-width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;">1</div><div>Tap the <b style="color:#c084fc;">small arrow tab</b> on the <b>left edge</b> of the screen to open the sidebar</div></div>' +
        '<div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:16px;"><div style="background:#7c3aed;color:#fff;min-width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;">2</div><div>In the sidebar, find and tap <b style="color:#c084fc;">"Keys"</b></div></div>' +
        '<div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:16px;"><div style="background:#7c3aed;color:#fff;min-width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;">3</div><div>A row of buttons will appear \u2014 tap the <b style="color:#c084fc;">keyboard icon</b> (first one, looks like \u2328\uFE0F)</div></div>' +
        '<div style="display:flex;align-items:flex-start;gap:12px;"><div style="background:#7c3aed;color:#fff;min-width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;">4</div><div>Your <b style="color:#c084fc;">' + deviceName + '</b> will pop up and you can start typing!</div></div>' +
        '</div>';

      var gotItBtn = document.createElement('div');
      gotItBtn.style.cssText = 'background:#7c3aed;color:#fff;padding:14px 0;border-radius:12px;font-size:17px;font-weight:600;font-family:Inter,system-ui,sans-serif;cursor:pointer;text-align:center;margin-top:22px;-webkit-tap-highlight-color:transparent;';
      gotItBtn.textContent = 'Got it!';
      card.appendChild(gotItBtn);

      overlay.appendChild(card);
      document.body.appendChild(overlay);

      sidebarHandle.style.animation = 'nebulaPulse 1.5s ease-in-out infinite';
      sidebarHandle.style.zIndex = '100000';

      function dismiss() {
        overlay.style.transition = 'opacity 0.4s';
        overlay.style.opacity = '0';
        sidebarHandle.style.animation = '';
        setTimeout(function() { overlay.remove(); }, 400);
        try { sessionStorage.setItem('nebula_kb_tip_done', '1'); } catch(e) {}
      }

      gotItBtn.addEventListener('click', dismiss);
      overlay.addEventListener('click', function(e) { if (e.target === overlay) dismiss(); });
      setTimeout(dismiss, 20000);
    }

    // Show keyboard tip after scroll tip on touch, or after 2s on desktop
    setTimeout(showKeyboardTip, isTouchDevice ? 3500 : 2000);

    // ---- 6C. AUTO-OPEN KEYBOARD ON TEXT CURSOR (touch only) ----
    if (isTouchDevice) {
      var lastCursor = '';
      var kbAutoOpened = false;

      function checkCursor() {
        var canvas = document.getElementById('noVNC_canvas');
        if (!canvas) return;
        var cursor = getComputedStyle(canvas).cursor;
        if (cursor === 'text' && lastCursor !== 'text' && !kbAutoOpened) {
          var kbBtn = document.getElementById('noVNC_keyboard_button');
          if (kbBtn) {
            kbBtn.click();
            kbAutoOpened = true;
            setTimeout(function() { kbAutoOpened = false; }, 2000);
          }
        }
        lastCursor = cursor;
      }

      setInterval(checkCursor, 500);

      document.addEventListener('touchend', function(e) {
        if (e.target && e.target.id === 'noVNC_canvas') {
          setTimeout(checkCursor, 300);
          setTimeout(checkCursor, 600);
        }
      }, { passive: true });

      // Keep scroll pinned while keyboard is open
      document.addEventListener('focusin', function(e) {
        if (e.target && e.target.id === 'noVNC_keyboardinput') {
          var pinInterval = setInterval(function() { window.scrollTo(0, 0); }, 100);
          e.target.addEventListener('blur', function() { clearInterval(pinInterval); }, { once: true });
        }
      });
    } // end touch-only auto-keyboard

  })();
})();
</script>`;
          
          // Inject before closing </body> or </html>, or after last </script>
          if (body.includes('</body>')) {
            body = body.replace('</body>', audioInjectScript + '</body>');
          } else if (body.includes('</html>')) {
            body = body.replace('</html>', audioInjectScript + '</html>');
          } else if (body.includes('</script>')) {
            // KasmVNC minified HTML has no </body> — inject after the last </script> tag
            const lastScript = body.lastIndexOf('</script>');
            body = body.substring(0, lastScript + 9) + audioInjectScript + body.substring(lastScript + 9);
            console.log('[Inject] Injected after last </script> tag, body length:', body.length);
          } else {
            body += audioInjectScript;
            console.log('[Inject] Appended to body, length:', body.length);
          }
          
          // Copy response headers, update content-length
          const headers = { ...proxyRes.headers };
          headers['content-length'] = Buffer.byteLength(body);
          delete headers['content-encoding']; // Remove gzip/br since we modified the body
          res.writeHead(proxyRes.statusCode, headers);
          res.end(body);
        });
      });
      proxyReq.on('error', (err) => {
        console.error(`[Proxy Inject Error] ${err.message}`);
        res.writeHead(502, { 'Content-Type': 'text/html' });
        res.end('<html><body style="background:#1a1a2e;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;"><div style="text-align:center;"><div style="font-size:48px;margin-bottom:20px;">🌌</div><h1>Browser Starting Up...</h1><p style="color:#aaa;">Auto-retrying in <span id="cd">5</span>s</p><button onclick="location.reload()" style="padding:10px 24px;font-size:15px;cursor:pointer;background:#7c3aed;color:#fff;border:none;border-radius:8px;">Retry Now</button></div><script>var s=5,cd=document.getElementById("cd");setInterval(function(){s--;cd.textContent=s;if(s<=0)location.reload();},1000);</script></body></html>');
      });
      proxyReq.end();
      return;
    }
    
    proxy.web(req, res, { target }, (err) => {
      console.error(`[Proxy Error] ${err.message}`);
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end('<html><body style="background:#1a1a2e;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;"><div style="text-align:center;"><div style="font-size:48px;margin-bottom:20px;">🌌</div><h1>Browser Starting Up...</h1><p style="color:#aaa;">Auto-retrying in <span id="cd">5</span>s</p><button onclick="location.reload()" style="padding:10px 24px;font-size:15px;cursor:pointer;background:#7c3aed;color:#fff;border:none;border-radius:8px;">Retry Now</button></div><script>var s=5,cd=document.getElementById("cd");setInterval(function(){s--;cd.textContent=s;if(s<=0)location.reload();},1000);</script></body></html>');
    });
    return;
  }
  
  // Routes
  if (url.pathname === '/' || url.pathname === '/index.html') {
    serveFile(res, path.join(__dirname, 'index.html'), 'text/html');
    return;
  }
  
  
  // API: Get status
  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getStatus()));
    return;
  }
  
  // API: Check if client already has a session (prevents duplicates)
  if (url.pathname === '/api/check-session') {
    const clientId = url.searchParams.get('clientId');
    if (!clientId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hasSession: false, error: 'Missing clientId' }));
      return;
    }
    
    const browser = findBrowserByClientId(clientId);
    if (browser) {
      // Verify session is actually alive (recent heartbeat)
      const lastHb = browser.lastHeartbeat || browser.lastUsed || 0;
      const age = Date.now() - lastHb;
      if (age < SESSION_TIMEOUT_MS) {
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        // Ensure cookie token exists
        let cookieToken = browserTokens.get(browser.id);
        if (!cookieToken) {
          cookieToken = generateSecureToken();
          browserTokens.set(browser.id, cookieToken);
          tokenToBrowser.set(cookieToken, browser.id);
        }
        // Generate a fresh one-time URL token for this access
        const urlToken = createUrlToken(browser.id);
        res.writeHead(200, {
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({
          hasSession: true,
          browserId: browser.id,
          browserUrl: `${protocol}://${host}/browser/${browser.id}/?token=${urlToken}`,
          sessionAge: Math.round(age / 1000),
        }));
        return;
      }
      // Heartbeat too old, clean up the stale session
      doReleaseBrowser(browser, 'stale session detected in check-session');
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hasSession: false }));
    return;
  }
  
  // API: Request browser (requires clientId to prevent duplicates)
  if (url.pathname === '/api/request-browser' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        let clientId = parsed.clientId;
        
        // If no clientId provided (old frontend), generate one from IP + user-agent for dedup
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
            message: `All ${BROWSERS.length} browsers are currently in use by other users.`,
            inUse: inUseCount,
            total: BROWSERS.length,
            suggestion: 'Sessions auto-expire after 5 minutes of inactivity. Please try again shortly.',
            retryAfterSeconds: 30,
          }));
          return;
        }
        
        const { browser, existing, cookieToken, urlToken } = result;
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        // URL contains one-time urlToken (consumed on first visit)
        const absoluteBrowserUrl = `${protocol}://${host}/browser/${browser.id}/?token=${urlToken}`;
        
        res.writeHead(200, {
          'Content-Type': 'application/json',
        });
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
  
  // API: Heartbeat (accepts browserId from injected script, or sessionId from frontend)
  if (url.pathname === '/api/heartbeat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        let alive = false;
        
        // Prefer browserId heartbeat (from injected KasmVNC script)
        if (parsed.browserId) {
          const browser = getBrowserById(parseInt(parsed.browserId, 10));
          if (browser && browser.inUse) {
            browser.lastHeartbeat = Date.now();
            // Also update session activity
            for (const [, session] of sessions) {
              if (session.browserId === browser.id) {
                session.lastActivity = Date.now();
                break;
              }
            }
            alive = true;
            // Sync heartbeat to Firebase periodically (every 5th call to reduce writes)
            if (Math.random() < 0.2) syncBrowserToFirebase(browser);
          }
        }
        // Fallback: sessionId heartbeat (from frontend)
        else if (parsed.sessionId) {
          const session = sessions.get(parsed.sessionId);
          if (session) {
            session.lastActivity = Date.now();
            const browser = getBrowserById(session.browserId);
            if (browser) {
              browser.lastHeartbeat = Date.now();
              alive = true;
            }
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
  
  // API: Release browser
  if (url.pathname === '/api/release' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        let released = false;
        
        // Release by clientId (preferred)
        if (parsed.clientId) {
          const browser = findBrowserByClientId(parsed.clientId);
          if (browser) {
            doReleaseBrowser(browser, `explicit release by client ${parsed.clientId}`);
            released = true;
          }
        }
        // Fallback: release by browserId
        else if (parsed.browserId) {
          const browser = getBrowserById(parseInt(parsed.browserId, 10));
          if (browser && browser.inUse) {
            doReleaseBrowser(browser, `explicit release by browserId ${parsed.browserId}`);
            released = true;
          }
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
  
  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// Handle WebSocket upgrades for browser proxy (VNC needs WebSocket)
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const browserRoute = parseBrowserPath(url.pathname);
  
  console.log(`[WS Upgrade] Incoming: ${url.pathname}`);
  
  let browser = null;
  let targetPath = req.url;
  
  if (browserRoute) {
    // Route like /browser/1/websockify
    browser = getBrowserById(browserRoute.browserId);
    targetPath = browserRoute.remainingPath + url.search;
  } else if (url.pathname === '/websockify' || url.pathname.startsWith('/api/')) {
    // Direct /websockify request - use cookie to find browser
    browser = getBrowserFromCookie(req);
    targetPath = url.pathname + url.search;
  }
  
  if (!browser) {
    console.log(`[WS Upgrade] FAILED - No browser found for ${url.pathname}`);
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\nNo browser session found. Please reload the page.');
    socket.destroy();
    return;
  }
  
  // === ACCESS CONTROL for WebSocket connections ===
  // Skip access control for audio WebSocket — audio path is already scoped to a browser ID
  const isAudioWs = browserRoute && (browserRoute.remainingPath === '/audio' || browserRoute.remainingPath.startsWith('/kasmaudio'));
  
  if (!isAudioWs && !validateBrowserAccess(req, browser.id)) {
    console.log(`[WS Access Denied] Browser ${browser.id} - no valid session token`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\nAccess denied. This browser session belongs to another user.');
    socket.destroy();
    return;
  }
  
  // Handle socket errors to prevent server crash
  socket.on('error', (err) => {
    console.log(`[WS] Client socket error (browser ${browser.id}): ${err.code || err.message}`);
  });
  
  socket.on('close', () => {
    if (!isAudioWs) trackWsDisconnect(browser.id);
  });
  
  if (isAudioWs) {
    // === AUDIO: pipe docker exec ffmpeg directly - bypasses broken Kasm relay ===
    const containerName = getContainerName(browser.id);
    const wsKey = req.headers['sec-websocket-key'];
    
    if (!wsKey) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\nMissing WebSocket key');
      socket.destroy();
      return;
    }
    
    // Complete the WebSocket handshake with the browser
    const acceptKey = computeWsAccept(wsKey);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
      '\r\n'
    );
    
    console.log(`[Audio] Starting ffmpeg pipe for browser ${browser.id} (container: ${containerName})`);
    
    // Kill any existing ffmpeg for THIS browser only (by tracking PID in our map)
    const existingKey = Array.from(audioProcesses.keys()).find(k => k.startsWith(`audio-${browser.id}-`));
    if (existingKey) {
      const oldProc = audioProcesses.get(existingKey);
      audioProcesses.delete(existingKey);
      if (oldProc && !oldProc.killed) {
        try { oldProc.kill('SIGKILL'); } catch(e) {}
      }
      console.log(`[Audio] Killed previous ffmpeg for browser ${browser.id}`);
    }
    
    // Small delay then start
    setTimeout(() => startFfmpeg(), 300);
    
    function startFfmpeg() {
    if (socket.destroyed) return; // Socket already gone during the wait
    
    // Spawn docker exec ffmpeg to capture PulseAudio and pipe out MPEG-TS (low-latency)
    const ffmpeg = spawn('docker', [
      'exec', containerName,
      'ffmpeg', '-nostdin',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-f', 'pulse', '-fragment_size', '2048', '-ar', '44100', '-i', 'default',
      '-f', 'mpegts', '-correct_ts_overflow', '0',
      '-codec:a', 'mp2', '-b:a', '192k', '-ac', '1',
      '-muxdelay', '0', '-flush_packets', '1',
      '-fflags', '+flush_packets+nobuffer',
      'pipe:1'
    ], { env: { ...process.env, HOME: '/var/run/pulse' } });
    
    // Store so we can clean up
    const audioKey = `audio-${browser.id}-${Date.now()}`;
    audioProcesses.set(audioKey, ffmpeg);
    
    ffmpeg.stdout.on('data', (chunk) => {
      if (!socket.destroyed) {
        try {
          socket.write(makeWsFrame(chunk));
        } catch (e) {
          // Socket gone
        }
      }
    });
    
    ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg && !msg.includes('frame=') && !msg.includes('size=')) {
        console.log(`[Audio] ffmpeg stderr (browser ${browser.id}): ${msg.substring(0, 200)}`);
      }
    });
    
    ffmpeg.on('error', (err) => {
      console.log(`[Audio] ffmpeg spawn error (browser ${browser.id}): ${err.message}`);
    });
    
    ffmpeg.on('close', (code) => {
      console.log(`[Audio] ffmpeg exited (browser ${browser.id}) code=${code}`);
      audioProcesses.delete(audioKey);
      if (!socket.destroyed) {
        // Send WebSocket close frame
        try { socket.write(Buffer.from([0x88, 0x00])); } catch(e) {}
        socket.destroy();
      }
    });
    
    // Handle incoming WebSocket frames from browser (close, ping)
    socket.on('data', (frame) => {
      if (frame.length < 2) return;
      const opcode = frame[0] & 0x0F;
      if (opcode === 0x08) {
        // Close frame received
        console.log(`[Audio] Browser sent close frame (browser ${browser.id})`);
        ffmpeg.kill('SIGTERM');
      } else if (opcode === 0x09) {
        // Ping - respond with pong
        try { socket.write(Buffer.from([0x8A, 0x00])); } catch(e) {}
      }
    });
    
    socket.on('close', () => {
      console.log(`[Audio] Socket closed, killing ffmpeg (browser ${browser.id})`);
      audioProcesses.delete(audioKey);
      if (!ffmpeg.killed) ffmpeg.kill('SIGTERM');
      setTimeout(() => { if (!ffmpeg.killed) ffmpeg.kill('SIGKILL'); }, 2000);
    });
    
    socket.on('error', (err) => {
      console.log(`[Audio] Socket error (browser ${browser.id}): ${err.message}`);
      if (!ffmpeg.killed) ffmpeg.kill('SIGTERM');
    });
    
    } // end startFfmpeg()
    
    return; // Audio handled, don't fall through to VNC
  }

  // === VNC WebSocket: TLS tunnel to KasmVNC container ===
  const tunnelPort = browser.port;
  const tunnelLabel = 'VNC';
  
  console.log(`[WS Upgrade] Creating ${tunnelLabel} TLS tunnel to ${browser.host}:${tunnelPort} (browser ${browser.id}), head=${head.length}b`);
  
  // Disable Nagle on client socket for lower latency VNC frames
  socket.setNoDelay(true);
  
  const tlsSocket = tls.connect({
    host: browser.host,
    port: tunnelPort,
    rejectUnauthorized: false,
  }, () => {
    // Disable Nagle on TLS socket too — critical for interactive VNC
    tlsSocket.setNoDelay(true);
    console.log(`[WS Upgrade] ${tunnelLabel} TLS connected to ${browser.host}:${tunnelPort}`);
    
    // VNC WebSocket: needs auth header
    const upgradeRequest = [
      `GET ${targetPath} HTTP/1.1`,
      `Host: ${browser.host}:${tunnelPort}`,
      `Upgrade: websocket`,
      `Connection: Upgrade`,
      `Authorization: ${KASM_AUTH}`,
      ...Object.entries(req.headers)
        .filter(([key]) => !['host', 'authorization'].includes(key.toLowerCase()))
        .map(([key, value]) => `${key}: ${value}`),
      '',
      ''
    ].join('\r\n');
    
    tlsSocket.write(upgradeRequest);
    
    if (head && head.length > 0) {
      tlsSocket.write(head);
    }
    socket.pipe(tlsSocket);
    tlsSocket.pipe(socket);
    
    // Track VNC WebSocket connections
    trackWsConnect(browser.id);
  });
  
  tlsSocket.on('error', (err) => {
    console.log(`[WS Upgrade] ${tunnelLabel} TLS error: ${err.code || err.message}`);
    if (!socket.destroyed) socket.destroy();
  });
  
  tlsSocket.on('close', () => {
    if (!socket.destroyed) socket.destroy();
  });
});

const PORT = process.env.PORT || 3600;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   🌌 Nebula Browser Session Manager + Reverse Proxy          ║
║                                                              ║
║   Server running on http://localhost:${PORT}                   ║
║                                                              ║
║   Available browsers: ${BROWSERS.length}                                        ║
║   Session timeout: ${SESSION_TIMEOUT_MS / 60000} minutes                               ║
║                                                              ║
║   Routes:                                                    ║
║   • /                   - Landing page                       ║
║   • /api/status         - Browser availability               ║
║   • /api/request-browser - Get a browser slot                ║
║   • /browser/1/*        - Proxy to browser 1 (port 6901)     ║
║   • /browser/2/*        - Proxy to browser 2 (port 6902)     ║
║   • ... up to /browser/5/*                                   ║
║                                                              ║
║   ONE TUNNEL to port ${PORT} handles everything!               ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
  
  // Sync initial browser status to Firebase
  // Restore state from Firebase first (survives restarts)
  restoreStateFromFirebase().then(() => {
    updateBrowserSummary();
    console.log('[Startup] State restored, summary synced to Firebase');
  }).catch(err => {
    console.log('[Startup] Firebase restore failed:', err.message);
    updateBrowserSummary();
  });
});
