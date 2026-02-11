/**
 * Advanced Transparent Proxy Server
 * Handles: WebSockets, Multi-origin resources, Streaming media
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import crypto from 'crypto';
import zlib from 'zlib';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = process.env.PORT || 8080;

// Session storage
const sessions = new Map();
const SESSION_COOKIE = '__px_sid';

// Allowed origins that resources can come from (CDNs, etc.)
// These are tracked per-session when encountered
class ProxySession {
  constructor(id) {
    this.id = id;
    this.primaryTarget = null;  // Main site (youtube.com)
    this.allowedOrigins = new Set();  // Additional origins (googlevideo.com, ytimg.com)
    this.cookies = new Map();  // Target domain -> cookies
    this.createdAt = Date.now();
  }
  
  setTarget(url) {
    const parsed = new URL(url);
    this.primaryTarget = parsed.origin;
    this.allowedOrigins.add(parsed.origin);
    return parsed;
  }
  
  addAllowedOrigin(origin) {
    this.allowedOrigins.add(origin);
  }
  
  isAllowedOrigin(origin) {
    return this.allowedOrigins.has(origin);
  }
}

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  let sessionId = cookies[SESSION_COOKIE];
  
  if (!sessionId || !sessions.has(sessionId)) {
    sessionId = crypto.randomBytes(16).toString('hex');
    sessions.set(sessionId, new ProxySession(sessionId));
  }
  
  return { sessionId, session: sessions.get(sessionId) };
}

function parseCookies(str) {
  const cookies = {};
  str.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k] = v.join('=');
  });
  return cookies;
}

async function decompressBody(buffer, encoding) {
  if (!encoding) return buffer;
  
  return new Promise((resolve, reject) => {
    const enc = encoding.toLowerCase();
    const handlers = {
      'gzip': zlib.gunzip,
      'deflate': zlib.inflate,
      'br': zlib.brotliDecompress,
    };
    
    const handler = handlers[enc];
    if (handler) {
      handler(buffer, (err, result) => err ? reject(err) : resolve(result));
    } else {
      resolve(buffer);
    }
  });
}

/**
 * Get the target URL for a request
 */
function resolveTargetUrl(req, session) {
  const url = req.url;
  
  // Initial navigation: /browse/https://youtube.com
  if (url.startsWith('/browse/')) {
    const encoded = url.slice('/browse/'.length);
    const decoded = decodeURIComponent(encoded);
    const normalized = decoded.startsWith('http') ? decoded : 'https://' + decoded;
    session.setTarget(normalized);
    return normalized;
  }
  
  // API endpoint to set target without navigating
  if (url.startsWith('/__proxy_target__/')) {
    const encoded = url.slice('/__proxy_target__/'.length);
    const decoded = decodeURIComponent(encoded);
    const normalized = decoded.startsWith('http') ? decoded : 'https://' + decoded;
    session.setTarget(normalized);
    return null; // Return null to indicate this was just setting target
  }
  
  // Regular request - route to primary target
  if (session.primaryTarget) {
    return session.primaryTarget + url;
  }
  
  return null;
}

/**
 * Determine if URL should be proxied based on session context
 */
function shouldProxyOrigin(origin, session, referer) {
  // Always allow primary target
  if (origin === session.primaryTarget) return true;
  
  // Check if origin is in allowed list
  if (session.isAllowedOrigin(origin)) return true;
  
  // Common CDNs for major sites - auto-allow
  const commonCdns = [
    'googlevideo.com', 'ytimg.com', 'ggpht.com', 'googleusercontent.com',
    'gstatic.com', 'googleapis.com', 'youtube.com', 'youtu.be',
    'twimg.com', 'twitter.com', 'x.com',
    'redd.it', 'redditmedia.com', 'redditstatic.com',
    'fbcdn.net', 'facebook.com', 'instagram.com', 'cdninstagram.com',
    'cloudflare.com', 'cloudfront.net', 'akamaized.net',
  ];
  
  try {
    const hostname = new URL(origin).hostname;
    if (commonCdns.some(cdn => hostname.endsWith(cdn))) {
      session.addAllowedOrigin(origin);
      return true;
    }
  } catch (e) {}
  
  // If referer is from our primary target, allow it
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      if (refOrigin === session.primaryTarget) {
        session.addAllowedOrigin(origin);
        return true;
      }
    } catch (e) {}
  }
  
  return false;
}

/**
 * Inject proxy helper script into HTML
 */
function injectProxyScript(html, session, proxyOrigin) {
  const script = `
<script data-proxy-injected="true">
(function() {
  const PROXY_ORIGIN = '${proxyOrigin}';
  const TARGET_ORIGIN = '${session.primaryTarget}';
  
  // Helper to check if URL needs proxying
  function needsProxy(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) return false;
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:')) return false;
    try {
      const parsed = new URL(url, window.location.href);
      return parsed.origin !== window.location.origin && parsed.origin !== TARGET_ORIGIN;
    } catch (e) {
      return false;
    }
  }
  
  // Override fetch for cross-origin requests
  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    let url = typeof input === 'string' ? input : input.url;
    
    // Log for debugging
    // console.log('[Proxy] fetch:', url);
    
    return origFetch.apply(this, arguments);
  };
  
  // Override XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    // console.log('[Proxy] XHR:', method, url);
    return origOpen.call(this, method, url, ...args);
  };
  
  // Suppress some errors
  window.addEventListener('error', function(e) {
    if (e.message && e.message.includes('Domains, protocols and ports must match')) {
      e.preventDefault();
      console.warn('[Proxy] Suppressed cross-origin error');
      return true;
    }
  }, true);
  
  // Override postMessage for cross-frame communication
  const origPostMessage = window.postMessage;
  window.postMessage = function(message, targetOrigin, transfer) {
    // Allow all postMessages within proxy
    if (targetOrigin && targetOrigin !== '*') {
      targetOrigin = '*';
    }
    return origPostMessage.call(this, message, targetOrigin, transfer);
  };
  
  console.log('[Proxy] Helper script loaded for', TARGET_ORIGIN);
})();
</script>`;

  // Inject after <head>
  if (html.includes('<head>')) {
    return html.replace('<head>', '<head>' + script);
  } else if (html.includes('<HEAD>')) {
    return html.replace('<HEAD>', '<HEAD>' + script);
  } else if (html.includes('<html>')) {
    return html.replace('<html>', '<html><head>' + script + '</head>');
  }
  return script + html;
}

/**
 * Rewrite HTML content
 */
function rewriteHtml(html, session, proxyOrigin) {
  let result = html;
  
  // Inject our script
  result = injectProxyScript(result, session, proxyOrigin);
  
  // Convert absolute URLs to target origin into relative URLs
  // This is the KEY to making it work - relative URLs go through the proxy automatically
  const targetOrigin = session.primaryTarget;
  if (targetOrigin) {
    // Replace https://target.com/path with /path
    result = result.replace(new RegExp(targetOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '');
    
    // Also handle protocol-relative //target.com/path
    const targetHost = new URL(targetOrigin).host;
    result = result.replace(new RegExp('//' + targetHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '');
  }
  
  return result;
}

/**
 * Main request handler
 */
async function handleRequest(req, res) {
  const proxyOrigin = `http://${req.headers.host}`;
  
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }
  
  const { sessionId, session } = getSession(req);
  
  // Landing page
  if (req.url === '/' && !session.primaryTarget) {
    return serveLandingPage(res, proxyOrigin);
  }
  
  // Resolve target URL
  const targetUrl = resolveTargetUrl(req, session);
  
  // Target setting endpoint
  if (targetUrl === null && req.url.startsWith('/__proxy_target__/')) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly`,
    });
    return res.end(JSON.stringify({ ok: true, target: session.primaryTarget }));
  }
  
  // No target set
  if (!targetUrl) {
    res.writeHead(302, { 'Location': '/' });
    return res.end();
  }
  
  // Proxy the request
  try {
    await proxyRequest(req, res, targetUrl, session, sessionId, proxyOrigin);
  } catch (e) {
    console.error('[ERROR]', e);
    res.writeHead(502);
    res.end('Proxy error: ' + e.message);
  }
}

/**
 * Proxy a request to the target
 */
async function proxyRequest(req, res, targetUrl, session, sessionId, proxyOrigin) {
  const parsed = new URL(targetUrl);
  const isHttps = parsed.protocol === 'https:';
  const transport = isHttps ? https : http;
  
  console.log(`[PROXY] -> ${req.method} ${targetUrl}`);
  
  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: req.method,
    headers: { ...req.headers },
    timeout: 30000,
  };
  
  // Fix headers for upstream
  options.headers.host = parsed.host;
  options.headers.referer = session.primaryTarget || parsed.origin;
  options.headers.origin = parsed.origin;
  
  // Don't accept encoding so we can modify response
  delete options.headers['accept-encoding'];
  
  // Remove our proxy cookies from upstream request
  if (options.headers.cookie) {
    options.headers.cookie = options.headers.cookie
      .split(';')
      .filter(c => !c.trim().startsWith(SESSION_COOKIE))
      .join(';');
  }
  
  const upstreamReq = transport.request(options, async (upstreamRes) => {
    const contentType = upstreamRes.headers['content-type'] || '';
    const isHtml = contentType.includes('text/html');
    const headers = { ...upstreamRes.headers };
    
    // Remove security headers
    const headersToRemove = [
      'content-security-policy',
      'content-security-policy-report-only', 
      'x-frame-options',
      'strict-transport-security',
      'x-xss-protection',
      'x-content-type-options',
    ];
    headersToRemove.forEach(h => delete headers[h]);
    
    // Set permissive CORS
    headers['access-control-allow-origin'] = '*';
    headers['access-control-allow-credentials'] = 'true';
    headers['access-control-allow-methods'] = '*';
    headers['access-control-allow-headers'] = '*';
    
    // Add our session cookie
    const existingCookies = headers['set-cookie'] || [];
    const cookieArr = Array.isArray(existingCookies) ? existingCookies : [existingCookies];
    cookieArr.push(`${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax`);
    headers['set-cookie'] = cookieArr;
    
    // Handle redirects
    if ([301, 302, 303, 307, 308].includes(upstreamRes.statusCode) && headers.location) {
      const redirectUrl = new URL(headers.location, targetUrl);
      
      if (redirectUrl.origin === session.primaryTarget) {
        // Same origin - make relative
        headers.location = redirectUrl.pathname + redirectUrl.search;
      } else {
        // Different origin - go through /browse/
        session.addAllowedOrigin(redirectUrl.origin);
        headers.location = '/browse/' + encodeURIComponent(redirectUrl.href);
      }
    }
    
    // Process HTML
    if (isHtml) {
      const chunks = [];
      upstreamRes.on('data', c => chunks.push(c));
      upstreamRes.on('end', async () => {
        try {
          let body = Buffer.concat(chunks);
          
          // Decompress
          const encoding = upstreamRes.headers['content-encoding'];
          if (encoding) {
            body = await decompressBody(body, encoding);
            delete headers['content-encoding'];
          }
          
          // Rewrite
          let text = body.toString('utf-8');
          text = rewriteHtml(text, session, proxyOrigin);
          
          headers['content-length'] = Buffer.byteLength(text);
          res.writeHead(upstreamRes.statusCode, headers);
          res.end(text);
        } catch (e) {
          console.error('[ERROR] HTML rewrite failed:', e);
          res.writeHead(500);
          res.end('Rewrite error');
        }
      });
    } else {
      // Stream other content directly
      res.writeHead(upstreamRes.statusCode, headers);
      upstreamRes.pipe(res);
    }
  });
  
  upstreamReq.on('error', (e) => {
    console.error('[ERROR] Upstream error:', e.message);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Bad Gateway: ' + e.message);
    }
  });
  
  upstreamReq.on('timeout', () => {
    console.error('[ERROR] Upstream timeout');
    upstreamReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504);
      res.end('Gateway Timeout');
    }
  });
  
  // Pipe request body
  req.pipe(upstreamReq);
}

/**
 * Serve landing page
 */
function serveLandingPage(res, proxyOrigin) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Transparent Web Proxy</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #0f0f23 0%, #1a1a3e 50%, #0f0f23 100%);
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      max-width: 600px;
      width: 100%;
      text-align: center;
    }
    h1 {
      font-size: 2.5em;
      margin-bottom: 10px;
      background: linear-gradient(90deg, #00d4ff, #7c3aed);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .subtitle {
      color: #888;
      margin-bottom: 40px;
      font-size: 1.1em;
    }
    .search-form {
      display: flex;
      gap: 10px;
      margin-bottom: 30px;
    }
    input[type="text"] {
      flex: 1;
      padding: 16px 24px;
      font-size: 16px;
      border: 2px solid #333;
      border-radius: 12px;
      background: rgba(255,255,255,0.05);
      color: white;
      outline: none;
      transition: border-color 0.2s;
    }
    input[type="text"]:focus {
      border-color: #7c3aed;
    }
    input[type="text"]::placeholder {
      color: #666;
    }
    button {
      padding: 16px 32px;
      font-size: 16px;
      font-weight: 600;
      background: linear-gradient(90deg, #7c3aed, #00d4ff);
      color: white;
      border: none;
      border-radius: 12px;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 40px rgba(124, 58, 237, 0.3);
    }
    .quick-links {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 12px;
      margin-top: 20px;
    }
    .quick-links a {
      padding: 10px 20px;
      background: rgba(255,255,255,0.05);
      border: 1px solid #333;
      border-radius: 8px;
      color: #00d4ff;
      text-decoration: none;
      font-size: 14px;
      transition: background 0.2s, border-color 0.2s;
    }
    .quick-links a:hover {
      background: rgba(124, 58, 237, 0.1);
      border-color: #7c3aed;
    }
    .info {
      margin-top: 60px;
      padding: 20px;
      background: rgba(255,255,255,0.03);
      border-radius: 12px;
      font-size: 14px;
      color: #666;
    }
    .info h3 {
      color: #888;
      margin-bottom: 10px;
    }
    .badge {
      display: inline-block;
      padding: 4px 8px;
      background: rgba(0, 212, 255, 0.1);
      color: #00d4ff;
      border-radius: 4px;
      font-size: 12px;
      margin-right: 8px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🌐 Transparent Proxy</h1>
    <p class="subtitle">
      <span class="badge">Server-Side</span>
      No URL rewriting • Works with YouTube
    </p>
    
    <form class="search-form" onsubmit="handleSubmit(event)">
      <input type="text" id="url" placeholder="Enter URL (e.g., youtube.com)" autofocus>
      <button type="submit">Browse →</button>
    </form>
    
    <div class="quick-links">
      <a href="/browse/https://www.youtube.com">YouTube</a>
      <a href="/browse/https://www.google.com">Google</a>
      <a href="/browse/https://www.reddit.com">Reddit</a>
      <a href="/browse/https://www.twitter.com">Twitter</a>
      <a href="/browse/https://www.twitch.tv">Twitch</a>
      <a href="/browse/https://www.github.com">GitHub</a>
    </div>
    
    <div class="info">
      <h3>How it works</h3>
      <p>Unlike URL-rewriting proxies, this server acts as a transparent gateway. 
      All your requests go through this single server, which forwards them to the target site. 
      This means no broken iframes, no "domains must match" errors, and proper YouTube support.</p>
    </div>
  </div>
  
  <script>
    function handleSubmit(e) {
      e.preventDefault();
      let url = document.getElementById('url').value.trim();
      if (!url) return;
      if (!url.startsWith('http')) url = 'https://' + url;
      window.location.href = '/browse/' + encodeURIComponent(url);
    }
  </script>
</body>
</html>`);
}

// Create HTTP server
const server = http.createServer(handleRequest);

// WebSocket proxy setup
const wss = new WebSocketServer({ server, path: /.*/ });

wss.on('connection', (clientWs, req) => {
  // Get session
  const { session } = getSession(req);
  
  if (!session.primaryTarget) {
    clientWs.close(1008, 'No target set');
    return;
  }
  
  // Build target WebSocket URL
  const wsProtocol = 'wss:'; // Most sites use WSS
  const targetWsUrl = session.primaryTarget.replace(/^http/, 'ws') + req.url;
  
  console.log(`[WS] Proxying WebSocket to ${targetWsUrl}`);
  
  // Connect to target
  const targetWs = new WebSocket(targetWsUrl, {
    headers: {
      'Origin': session.primaryTarget,
      'Host': new URL(session.primaryTarget).host,
    },
  });
  
  targetWs.on('open', () => {
    console.log('[WS] Connected to target');
  });
  
  targetWs.on('message', (data) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data);
    }
  });
  
  targetWs.on('close', (code, reason) => {
    console.log('[WS] Target closed:', code, reason?.toString());
    clientWs.close(code, reason);
  });
  
  targetWs.on('error', (err) => {
    console.error('[WS] Target error:', err.message);
    clientWs.close(1011, err.message);
  });
  
  clientWs.on('message', (data) => {
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(data);
    }
  });
  
  clientWs.on('close', () => {
    targetWs.close();
  });
  
  clientWs.on('error', (err) => {
    console.error('[WS] Client error:', err.message);
    targetWs.close();
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              🌐 TRANSPARENT WEB PROXY                        ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  URL:  http://localhost:${PORT}                                  ║
║                                                              ║
║  This is a SERVER-SIDE proxy (CroxyProxy-style).             ║
║  Unlike Ultraviolet, it doesn't rewrite URLs in paths.       ║
║                                                              ║
║  Features:                                                   ║
║   ✓ Session-based target tracking                            ║
║   ✓ WebSocket support                                        ║
║   ✓ Streaming media support                                  ║
║   ✓ No "domains must match" errors                           ║
║   ✓ Works with YouTube, Reddit, etc.                         ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);
});

// Cleanup old sessions periodically
setInterval(() => {
  const now = Date.now();
  const maxAge = 4 * 60 * 60 * 1000; // 4 hours
  
  for (const [id, session] of sessions) {
    if (now - session.createdAt > maxAge) {
      sessions.delete(id);
    }
  }
}, 60 * 1000);
