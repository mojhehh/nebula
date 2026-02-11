/**
 * Transparent Server-Side Proxy (CroxyProxy-style)
 * 
 * This is fundamentally different from URL-rewriting proxies:
 * - No URL encoding in paths
 * - Session-based target tracking
 * - Full transparent proxying
 * - Works with iframes, WebSockets, etc.
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import crypto from 'crypto';
import zlib from 'zlib';

const PORT = process.env.PORT || 8080;

// Session storage: maps session ID -> current target origin
const sessions = new Map();

// Cookie name for tracking sessions
const SESSION_COOKIE = '__proxy_session';
const TARGET_COOKIE = '__proxy_target';

/**
 * Generate a session ID
 */
function generateSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Get or create session from request
 */
function getSession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  let sessionId = cookies[SESSION_COOKIE];
  let target = cookies[TARGET_COOKIE];
  
  if (!sessionId) {
    sessionId = generateSessionId();
  }
  
  // Check URL for initial target (e.g., /browse/https://youtube.com)
  if (req.url.startsWith('/browse/')) {
    const encoded = req.url.slice('/browse/'.length);
    try {
      target = decodeURIComponent(encoded);
      // Normalize
      if (!target.startsWith('http')) {
        target = 'https://' + target;
      }
      const parsed = new URL(target);
      target = parsed.origin; // Store just the origin
      sessions.set(sessionId, { target, fullUrl: parsed.href });
    } catch (e) {
      console.error('Invalid target URL:', encoded);
    }
  }
  
  // Get from memory if not in cookie
  if (!target && sessions.has(sessionId)) {
    target = sessions.get(sessionId).target;
  }
  
  return { sessionId, target };
}

/**
 * Parse cookies from header
 */
function parseCookies(cookieHeader) {
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name) {
      cookies[name] = rest.join('=');
    }
  });
  return cookies;
}

/**
 * Decompress response body
 */
function decompressBody(buffer, encoding) {
  return new Promise((resolve, reject) => {
    if (!encoding) {
      resolve(buffer);
      return;
    }
    
    const enc = encoding.toLowerCase();
    if (enc === 'gzip') {
      zlib.gunzip(buffer, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    } else if (enc === 'deflate') {
      zlib.inflate(buffer, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    } else if (enc === 'br') {
      zlib.brotliDecompress(buffer, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    } else {
      resolve(buffer);
    }
  });
}

/**
 * Inject our control script into HTML
 */
function injectControlScript(html, proxyOrigin) {
  const script = `
<script>
(function() {
  // Intercept navigation
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  
  history.pushState = function(state, title, url) {
    console.log('[Proxy] pushState:', url);
    return originalPushState.apply(this, arguments);
  };
  
  history.replaceState = function(state, title, url) {
    console.log('[Proxy] replaceState:', url);
    return originalReplaceState.apply(this, arguments);
  };
  
  // Intercept fetch to log/debug
  const originalFetch = window.fetch;
  window.fetch = function(url, options) {
    console.log('[Proxy] fetch:', url);
    return originalFetch.apply(this, arguments);
  };
  
  // Intercept XHR
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    console.log('[Proxy] XHR:', method, url);
    return originalOpen.apply(this, arguments);
  };
})();
</script>
`;
  
  // Inject after <head> or at start of document
  if (html.includes('<head>')) {
    return html.replace('<head>', '<head>' + script);
  } else if (html.includes('<html>')) {
    return html.replace('<html>', '<html><head>' + script + '</head>');
  }
  return script + html;
}

/**
 * Rewrite URLs in HTML to be relative (so they go through this proxy)
 */
function rewriteHtmlUrls(html, targetOrigin, proxyOrigin) {
  // For transparent proxy, we mainly need to ensure:
  // 1. Absolute URLs to the target become relative
  // 2. Remove CSP headers (done in response)
  // 3. Inject control script
  
  let result = html;
  
  // Make absolute URLs to target origin relative
  const originEscaped = targetOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  result = result.replace(new RegExp(originEscaped, 'g'), '');
  
  // Also handle protocol-relative URLs for the target
  const targetHost = new URL(targetOrigin).host;
  result = result.replace(new RegExp(`//${targetHost}`, 'g'), '');
  
  // Inject control script
  result = injectControlScript(result, proxyOrigin);
  
  return result;
}

/**
 * Rewrite CSS urls
 */
function rewriteCssUrls(css, targetOrigin) {
  // Make absolute URLs relative
  const originEscaped = targetOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.replace(new RegExp(originEscaped, 'g'), '');
}

/**
 * Main request handler
 */
async function handleRequest(req, res) {
  const proxyOrigin = `http://${req.headers.host}`;
  
  console.log(`[REQUEST] ${req.method} ${req.url}`);
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }
  
  // Serve landing page
  if (req.url === '/' && !req.headers.cookie?.includes(TARGET_COOKIE)) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>Transparent Proxy</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: white;
      min-height: 100vh;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      text-align: center;
      padding: 40px;
    }
    h1 {
      font-size: 3em;
      margin-bottom: 10px;
    }
    .subtitle {
      color: #888;
      margin-bottom: 40px;
    }
    input {
      width: 400px;
      padding: 15px 20px;
      font-size: 16px;
      border: none;
      border-radius: 25px;
      outline: none;
    }
    button {
      padding: 15px 40px;
      font-size: 16px;
      background: #e94560;
      color: white;
      border: none;
      border-radius: 25px;
      cursor: pointer;
      margin-left: 10px;
    }
    button:hover {
      background: #ff6b6b;
    }
    .quick-links {
      margin-top: 30px;
    }
    .quick-links a {
      color: #4ecdc4;
      margin: 0 15px;
      text-decoration: none;
    }
    .quick-links a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🌐 Transparent Proxy</h1>
    <p class="subtitle">Server-side proxy - no URL rewriting needed</p>
    <form action="/browse" method="GET" onsubmit="handleSubmit(event)">
      <input type="text" id="url" name="url" placeholder="Enter URL (e.g., youtube.com)" autofocus>
      <button type="submit">Go!</button>
    </form>
    <div class="quick-links">
      <a href="/browse/https://www.youtube.com">YouTube</a>
      <a href="/browse/https://www.google.com">Google</a>
      <a href="/browse/https://www.reddit.com">Reddit</a>
      <a href="/browse/https://www.twitter.com">Twitter</a>
    </div>
  </div>
  <script>
    function handleSubmit(e) {
      e.preventDefault();
      let url = document.getElementById('url').value.trim();
      if (!url.startsWith('http')) {
        url = 'https://' + url;
      }
      window.location.href = '/browse/' + encodeURIComponent(url);
    }
  </script>
</body>
</html>
    `);
    return;
  }
  
  // Get session and target
  const { sessionId, target } = getSession(req);
  
  if (!target) {
    res.writeHead(302, { 'Location': '/' });
    res.end();
    return;
  }
  
  // Build target URL
  let targetUrl;
  if (req.url.startsWith('/browse/')) {
    // Initial navigation - use the full URL from the browse path
    const session = sessions.get(sessionId);
    targetUrl = session?.fullUrl || target;
  } else {
    // Subsequent request - append path to target origin
    targetUrl = target + req.url;
  }
  
  console.log(`[PROXY] ${req.method} ${targetUrl}`);
  
  try {
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    
    // Build request options
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers: { ...req.headers },
    };
    
    // Fix headers
    options.headers.host = parsed.host;
    delete options.headers['accept-encoding']; // Need to read body for potential rewriting
    
    // Handle referer
    if (options.headers.referer) {
      try {
        const refUrl = new URL(options.headers.referer);
        options.headers.referer = target + refUrl.pathname + refUrl.search;
      } catch (e) {
        options.headers.referer = target;
      }
    }
    
    // Fix origin for CORS
    if (options.headers.origin) {
      options.headers.origin = target;
    }
    
    // Make upstream request
    const upstreamReq = transport.request(options, async (upstreamRes) => {
      const contentType = upstreamRes.headers['content-type'] || '';
      const isHtml = contentType.includes('text/html');
      const isCss = contentType.includes('text/css');
      
      // Build response headers
      const headers = { ...upstreamRes.headers };
      
      // Remove security headers that break proxying
      delete headers['content-security-policy'];
      delete headers['content-security-policy-report-only'];
      delete headers['x-frame-options'];
      delete headers['strict-transport-security'];
      delete headers['x-content-type-options'];
      
      // Set CORS headers
      headers['access-control-allow-origin'] = '*';
      headers['access-control-allow-credentials'] = 'true';
      
      // Set session cookies
      const existingCookies = headers['set-cookie'] || [];
      const cookieArray = Array.isArray(existingCookies) ? existingCookies : [existingCookies];
      cookieArray.push(`${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly`);
      cookieArray.push(`${TARGET_COOKIE}=${encodeURIComponent(target)}; Path=/`);
      headers['set-cookie'] = cookieArray;
      
      // Handle redirects - rewrite to stay on proxy
      if (upstreamRes.statusCode >= 300 && upstreamRes.statusCode < 400 && headers.location) {
        const redirectUrl = new URL(headers.location, targetUrl);
        
        // If redirect is to same origin, make it relative
        if (redirectUrl.origin === target) {
          headers.location = redirectUrl.pathname + redirectUrl.search;
        } else {
          // Different origin - update session and redirect to /browse/
          sessions.set(sessionId, { target: redirectUrl.origin, fullUrl: redirectUrl.href });
          headers.location = '/browse/' + encodeURIComponent(redirectUrl.href);
        }
      }
      
      // If HTML or CSS, rewrite
      if (isHtml || isCss) {
        const chunks = [];
        upstreamRes.on('data', chunk => chunks.push(chunk));
        upstreamRes.on('end', async () => {
          try {
            let body = Buffer.concat(chunks);
            
            // Decompress if needed
            const encoding = upstreamRes.headers['content-encoding'];
            if (encoding) {
              body = await decompressBody(body, encoding);
              delete headers['content-encoding'];
            }
            
            let text = body.toString('utf-8');
            
            if (isHtml) {
              text = rewriteHtmlUrls(text, target, proxyOrigin);
            } else if (isCss) {
              text = rewriteCssUrls(text, target);
            }
            
            headers['content-length'] = Buffer.byteLength(text);
            res.writeHead(upstreamRes.statusCode, headers);
            res.end(text);
          } catch (e) {
            console.error('[ERROR] Rewrite failed:', e);
            res.writeHead(500);
            res.end('Proxy error: ' + e.message);
          }
        });
      } else {
        // Stream other content
        res.writeHead(upstreamRes.statusCode, headers);
        upstreamRes.pipe(res);
      }
    });
    
    upstreamReq.on('error', (e) => {
      console.error('[ERROR] Upstream request failed:', e);
      res.writeHead(502);
      res.end('Bad Gateway: ' + e.message);
    });
    
    // Pipe request body for POST/PUT/etc
    req.pipe(upstreamReq);
    
  } catch (e) {
    console.error('[ERROR] Request handling failed:', e);
    res.writeHead(500);
    res.end('Proxy error: ' + e.message);
  }
}

// Create and start server
const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║     🌐 Transparent Proxy Server Started          ║
╠═══════════════════════════════════════════════════╣
║  Port: ${PORT}                                        ║
║  Mode: Server-side (CroxyProxy-style)            ║
║                                                   ║
║  How it works:                                   ║
║  1. User visits http://localhost:${PORT}             ║
║  2. Enters target URL (e.g., youtube.com)        ║
║  3. All requests stay on THIS server             ║
║  4. No URL rewriting = no iframe issues!         ║
║                                                   ║
║  This is fundamentally different from            ║
║  Ultraviolet/URL-rewriting proxies!              ║
╚═══════════════════════════════════════════════════╝
  `);
});
