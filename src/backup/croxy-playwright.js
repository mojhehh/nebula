/**
 * CroxyProxy via Playwright
 * 
 * Uses a real browser to interact with CroxyProxy
 * Your browser only talks to localhost:3000
 * Playwright handles all CroxyProxy interaction behind the scenes
 */

import http from 'http';
import https from 'https';
import { chromium } from 'playwright';

const PORT = process.env.PORT || 3001;
const CROXY_URL = 'https://www.croxyproxy.com';

// Cache for CroxyProxy URLs - prevents fetching again on rapid requests
const urlCache = new Map();
const resourceCache = new Map(); // Cache for /proxy/ resources
const CACHE_TTL = 300000; // 5 minutes - CroxyProxy URLs are stable

let browser = null;
let browserContext = null;
let croxyPage = null; // Keep a page open for resource fetching

/**
 * Initialize Playwright browser
 */
async function initBrowser() {
  if (browser) return;
  
  console.log('[BROWSER] Launching Chromium...');
  
  browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  });
  
  browserContext = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true
  });
  
  console.log('[BROWSER] Ready!');
}

/**
 * Fetch URL through CroxyProxy using Playwright
 */
async function fetchViaCroxy(targetUrl) {
  await initBrowser();
  
  const page = await browserContext.newPage();
  
  try {
    console.log(`[CROXY] Navigating to CroxyProxy...`);
    
    // Go to CroxyProxy
    await page.goto(CROXY_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Find the URL input and submit
    console.log(`[CROXY] Submitting URL: ${targetUrl}`);
    
    // Wait for the input field with id="url"
    await page.waitForSelector('#url', { timeout: 10000 });
    
    // Fill in the URL - CroxyProxy uses input with id="url"
    await page.fill('#url', targetUrl);
    console.log('[CROXY] URL filled in input field');
    
    // Click the Go button with id="requestSubmit"
    console.log('[CROXY] Clicking Go button (#requestSubmit)...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {}),
      page.click('#requestSubmit')
    ]);
    
    // Wait for the actual content to load (CroxyProxy redirects through /servers)
    await page.waitForTimeout(3000);
    
    // Check if we're still on servers page and need to wait more
    if (page.url().includes('/servers')) {
      console.log('[CROXY] On servers page, waiting for redirect...');
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }
    
    console.log(`[CROXY] Page loaded: ${page.url()}`);
    
    // Wait for content to load
    await page.waitForTimeout(2000);
    
    // Get the page content
    const content = await page.content();
    
    // Get cookies for future requests
    const cookies = await browserContext.cookies();
    
    // Keep this page for fetching resources (don't close it!)
    if (croxyPage) {
      try { await croxyPage.close(); } catch(e) {}
    }
    croxyPage = page;
    
    return {
      content,
      url: page.url(),
      cookies
    };
    
  } catch (e) {
    console.error('[CROXY] Error:', e.message);
    await page.close();
    throw e;
  }
}

/**
 * Rewrite CroxyProxy content for compatibility
 * Route IP-based URLs through /proxy/ endpoint for iPad compatibility
 */
function rewriteContent(content, proxyOrigin, croxyBaseUrl) {
  if (!croxyBaseUrl) return content;
  
  const croxyOrigin = new URL(croxyBaseUrl).origin;
  let result = content;
  
  // For iPad: Route ALL CroxyProxy IP URLs through our /proxy/ endpoint
  // because iPads block direct IP address connections
  
  // 1. Rewrite src, href, srcset attributes with IP URLs
  result = result.replace(/((?:src|href|srcset)\s*=\s*["'])(https?:\/\/\d+\.\d+\.\d+\.\d+[^"']*)(["'])/gi, 
    (match, prefix, url, suffix) => `${prefix}/proxy/${encodeURIComponent(url)}${suffix}`
  );
  
  // 2. Rewrite background-image and other url() in CSS
  result = result.replace(/(url\s*\(\s*["']?)(https?:\/\/\d+\.\d+\.\d+\.\d+[^"'\)]*)(["']?\s*\))/gi,
    (match, prefix, url, suffix) => `${prefix}/proxy/${encodeURIComponent(url)}${suffix}`
  );
  
  // 3. Rewrite relative URLs to use CroxyProxy origin
  result = result.replace(/((?:src|href)\s*=\s*["'])\/(?!proxy\/)([^"']*)(["'])/gi,
    (match, prefix, path, suffix) => `${prefix}/proxy/${encodeURIComponent(croxyOrigin + '/' + path)}${suffix}`
  );
  
  // 4. Add base tag for remaining relative URLs
  if (!result.includes('<base')) {
    result = result.replace(/<head([^>]*)>/i, `<head$1><base href="${croxyOrigin}/">`);
  }
  
  // 5. Inject script to intercept dynamic requests
  const interceptScript = `<script>
(function() {
  var CROXY_ORIGIN = "${croxyOrigin}";
  var PROXY_PREFIX = "/proxy/";
  
  // Convert URL to proxied version
  function proxyUrl(url) {
    if (!url) return url;
    var s = String(url);
    
    // Skip already proxied URLs
    if (s.startsWith(PROXY_PREFIX) || s.startsWith(location.origin + PROXY_PREFIX)) return s;
    
    // Skip data: and blob: URLs
    if (s.startsWith('data:') || s.startsWith('blob:')) return s;
    
    // Proxy IP-based URLs (CroxyProxy servers)
    if (/^https?:\\/\\/\\d+\\.\\d+\\.\\d+\\.\\d+/.test(s)) {
      return PROXY_PREFIX + encodeURIComponent(s);
    }
    
    // Proxy external CORS domains through our server
    // YouTube needs: gstatic.com, googlevideo.com, ytimg.com, youtube.com
    if (/^https?:\\/\\/(www\\.)?(gstatic\\.com|googlevideo\\.com|ytimg\\.com|youtube\\.com|google\\.com)/.test(s)) {
      return PROXY_PREFIX + encodeURIComponent(s);
    }
    
    // Proxy relative URLs (make absolute first)
    if (s.startsWith('/') && !s.startsWith('//')) {
      return PROXY_PREFIX + encodeURIComponent(CROXY_ORIGIN + s);
    }
    
    return s;
  }
  
  // Intercept fetch
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    var url = (input instanceof Request) ? input.url : String(input);
    var proxied = proxyUrl(url);
    if (proxied !== url) {
      if (input instanceof Request) {
        input = new Request(proxied, input);
      } else {
        input = proxied;
      }
    }
    return origFetch.call(this, input, init);
  };
  
  // Intercept XMLHttpRequest
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    var proxied = proxyUrl(url);
    var args = Array.prototype.slice.call(arguments);
    args[1] = proxied;
    return origOpen.apply(this, args);
  };
  
  // Block problematic history API calls
  var origReplaceState = History.prototype.replaceState;
  History.prototype.replaceState = function(state, title, url) {
    try {
      // Check if URL has origin mismatch
      if (url) {
        var urlStr = String(url);
        if (urlStr.includes('://') && !urlStr.startsWith(location.origin)) {
          console.log('[PROXY] Blocked replaceState to:', urlStr);
          return; // Skip problematic calls
        }
        // Block themeRefresh URLs that cause reloads
        if (urlStr.includes('themeRefresh')) {
          console.log('[PROXY] Blocked themeRefresh replaceState');
          return;
        }
      }
      return origReplaceState.apply(this, arguments);
    } catch(e) {
      console.log('[PROXY] replaceState error caught:', e.message);
    }
  };
  
  // Suppress CORS error spam in console
  var origConsoleError = console.error;
  console.error = function() {
    var msg = arguments[0];
    if (typeof msg === 'string' && (msg.includes('CORS') || msg.includes('blocked'))) {
      return; // Silence CORS errors
    }
    return origConsoleError.apply(this, arguments);
  };
  
  console.log('[PROXY] Request interception active');
})();
</script>`;

  // Inject at start of head
  result = result.replace(/<head([^>]*)>/i, (match) => match + interceptScript);
  
  return result;
}

/**
 * Main HTTP server
 */
const server = http.createServer(async (req, res) => {
  const proxyOrigin = `http://${req.headers.host}`;
  
  console.log(`\n[${new Date().toISOString()}] ${req.method} ${req.url}`);
  
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Client-side logging endpoint
  if (req.url.startsWith('/log?')) {
    const params = new URLSearchParams(req.url.slice(5));
    const msg = params.get('msg') || '';
    console.log(`[CLIENT] ${msg}`);
    res.writeHead(200);
    res.end('ok');
    return;
  }

  // PROXY endpoint - fetch resources for the client
  // Routes: CroxyProxy IP URLs via Playwright, external URLs via direct fetch
  if (req.url.startsWith('/proxy/')) {
    const targetUrl = decodeURIComponent(req.url.slice(7));
    console.log(`[PROXY] ${targetUrl.slice(0, 100)}`);
    
    // Check cache
    if (resourceCache.has(targetUrl)) {
      const cached = resourceCache.get(targetUrl);
      console.log(`[PROXY] Cache hit`);
      res.writeHead(200, { 
        'Content-Type': cached.contentType || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(cached.data);
      return;
    }
    
    // Determine if this is a CroxyProxy IP URL or external URL
    const isCroxyProxyUrl = /^https?:\/\/\d+\.\d+\.\d+\.\d+/.test(targetUrl);
    
    if (isCroxyProxyUrl) {
      // CroxyProxy URLs need to be fetched via Playwright (for cookies/session)
      if (!croxyPage) {
        console.log(`[PROXY] No CroxyProxy session - returning 503`);
        res.writeHead(503);
        res.end('No CroxyProxy session. Visit a page first.');
        return;
      }
      
      try {
        // Fetch the resource using Playwright's page context (includes cookies/session)
        const result = await croxyPage.evaluate(async (url) => {
          try {
            const resp = await fetch(url, { credentials: 'include' });
            const contentType = resp.headers.get('content-type') || 'application/octet-stream';
            
            // For binary content
            if (contentType.includes('image') || contentType.includes('video') || 
                contentType.includes('audio') || contentType.includes('font') ||
                contentType.includes('octet-stream') || contentType.includes('woff')) {
              const buffer = await resp.arrayBuffer();
              const bytes = new Uint8Array(buffer);
              let binary = '';
              for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
              }
              return { ok: resp.ok, status: resp.status, contentType, data: btoa(binary), binary: true };
            }
            
            // For text content
            const text = await resp.text();
            return { ok: resp.ok, status: resp.status, contentType, data: text, binary: false };
          } catch(e) {
            return { ok: false, status: 500, error: e.message };
          }
        }, targetUrl);
        
        if (!result.ok) {
          console.log(`[PROXY] CroxyProxy fetch failed: ${result.status} - ${result.error || ''}`);
          res.writeHead(result.status || 502);
          res.end(result.error || 'Fetch failed');
          return;
        }
        
        console.log(`[PROXY] CroxyProxy OK: ${result.contentType?.slice(0, 30)}`);
        
        let body;
        if (result.binary) {
          body = Buffer.from(result.data, 'base64');
        } else {
          // Rewrite URLs in text responses
          let text = result.data;
          text = text.replace(/(https?:\/\/\d+\.\d+\.\d+\.\d+[^"'\s<>)]*)/gi, 
            (match) => '/proxy/' + encodeURIComponent(match)
          );
          body = Buffer.from(text, 'utf8');
        }
        
        // Cache and respond
        cacheAndRespond(res, targetUrl, result.contentType, body);
        
      } catch (e) {
        console.error('[PROXY] CroxyProxy error:', e.message);
        res.writeHead(502);
        res.end('Proxy error: ' + e.message);
      }
      
    } else {
      // External URLs (gstatic, googlevideo, etc) - fetch directly via Node.js
      try {
        const urlObj = new URL(targetUrl);
        const protocol = urlObj.protocol === 'https:' ? https : http;
        
        const proxyReq = protocol.request(targetUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.youtube.com/'
          }
        }, (proxyRes) => {
          const chunks = [];
          const contentType = proxyRes.headers['content-type'] || 'application/octet-stream';
          
          proxyRes.on('data', chunk => chunks.push(chunk));
          proxyRes.on('end', () => {
            const body = Buffer.concat(chunks);
            console.log(`[PROXY] External OK: ${contentType.slice(0, 30)} (${body.length} bytes)`);
            cacheAndRespond(res, targetUrl, contentType, body);
          });
        });
        
        proxyReq.on('error', (e) => {
          console.error('[PROXY] External fetch error:', e.message);
          res.writeHead(502);
          res.end('External fetch failed: ' + e.message);
        });
        
        proxyReq.end();
        
      } catch (e) {
        console.error('[PROXY] External URL error:', e.message);
        res.writeHead(500);
        res.end('Invalid URL: ' + e.message);
      }
    }
    return;
  }
  
  // Helper function to cache and respond
  function cacheAndRespond(res, url, contentType, body) {
    // Cache the result (limit cache size)
    if (resourceCache.size > 500) {
      const firstKey = resourceCache.keys().next().value;
      resourceCache.delete(firstKey);
    }
    resourceCache.set(url, { contentType, data: body });
    
    res.writeHead(200, { 
      'Content-Type': contentType || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600'
    });
    res.end(body);
  }

  // Homepage
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>🌐 CroxyProxy (Playwright)</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      padding: 50px;
      border-radius: 24px;
      backdrop-filter: blur(20px);
      max-width: 650px;
      width: 100%;
      box-shadow: 0 25px 50px rgba(0,0,0,0.3);
    }
    h1 { color: #fff; margin-bottom: 10px; text-align: center; font-size: 2.5em; }
    .subtitle { color: rgba(255,255,255,0.6); text-align: center; margin-bottom: 40px; }
    form { display: flex; gap: 12px; }
    input[type="url"] {
      flex: 1; padding: 18px 24px; border: 2px solid rgba(255,255,255,0.1);
      border-radius: 14px; font-size: 16px; background: rgba(0,0,0,0.3);
      color: #fff; outline: none; transition: all 0.3s;
    }
    input[type="url"]:focus { border-color: #6366f1; background: rgba(0,0,0,0.5); }
    input[type="url"]::placeholder { color: rgba(255,255,255,0.4); }
    button {
      padding: 18px 36px; border: none; border-radius: 14px;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      color: white; font-size: 16px; font-weight: 600; cursor: pointer; transition: all 0.3s;
    }
    button:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(99,102,241,0.4); }
    .quick-links { display: flex; gap: 10px; margin-top: 30px; justify-content: center; flex-wrap: wrap; }
    .quick-link {
      padding: 10px 20px; background: rgba(255,255,255,0.1); border-radius: 20px;
      color: rgba(255,255,255,0.8); text-decoration: none; font-size: 14px; transition: all 0.3s;
    }
    .quick-link:hover { background: rgba(255,255,255,0.2); color: #fff; }
    .info { color: rgba(255,255,255,0.5); text-align: center; margin-top: 30px; font-size: 13px; line-height: 1.6; }
    .info strong { color: #10b981; }
    .badge { background: #10b981; color: #000; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🌐 Web Proxy</h1>
    <p class="subtitle">Powered by <span class="badge">Playwright + CroxyProxy</span></p>
    
    <form action="/go" method="GET">
      <input type="url" name="url" placeholder="https://www.youtube.com" required autofocus>
      <button type="submit">Browse</button>
    </form>
    
    <div class="quick-links">
      <a href="/go?url=https://www.youtube.com" class="quick-link">📺 YouTube</a>
      <a href="/go?url=https://www.google.com" class="quick-link">🔍 Google</a>
      <a href="/go?url=https://www.twitter.com" class="quick-link">🐦 Twitter</a>
      <a href="/go?url=https://www.reddit.com" class="quick-link">🔶 Reddit</a>
    </div>
    
    <p class="info">
      <strong>✓ Your browser only connects to localhost</strong><br>
      Playwright automates a headless browser to use CroxyProxy
    </p>
  </div>
</body>
</html>
    `);
    return;
  }

  // Handle /go?url=...
  if (req.url.startsWith('/go?')) {
    const params = new URLSearchParams(req.url.slice(4));
    let targetUrl = params.get('url');
    
    // If themeRefresh is in the request, serve cached content WITHOUT redirect
    // The redirect was causing the white flash!
    if (params.has('themeRefresh') || (targetUrl && targetUrl.includes('themeRefresh'))) {
      console.log(`[PROXY] themeRefresh detected - serving cached content (no redirect)`);
      // Clean the target URL for cache lookup
      if (targetUrl) {
        try {
          const urlObj = new URL(targetUrl);
          urlObj.searchParams.delete('themeRefresh');
          targetUrl = urlObj.toString();
        } catch(e) {}
      }
      // Serve from cache if available
      const cached = urlCache.get(targetUrl);
      if (cached) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(cached.content);
        return;
      }
      // If not cached, continue to fetch
    }
    
    // Strip themeRefresh and other YouTube refresh params - they break things
    if (targetUrl) {
      try {
        const urlObj = new URL(targetUrl);
        urlObj.searchParams.delete('themeRefresh');
        urlObj.searchParams.delete('theme');
        targetUrl = urlObj.toString();
      } catch(e) {}
    }
    
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing url parameter');
      return;
    }
    
    // Check cache first for the content
    const cacheKey = targetUrl;
    const cached = urlCache.get(cacheKey);
    if (cached && (Date.now() - cached.time) < CACHE_TTL) {
      console.log(`[PROXY] Cache hit for: ${targetUrl}`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(cached.content);
      return;
    }
    
    try {
      console.log(`[PROXY] Fetching: ${targetUrl}`);
      
      const result = await fetchViaCroxy(targetUrl);
      
      // Rewrite content
      const rewritten = rewriteContent(result.content, proxyOrigin, result.url);
      
      // Cache the result
      urlCache.set(cacheKey, { content: rewritten, time: Date.now() });
      
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(rewritten);
      
    } catch (e) {
      console.error('[PROXY] Error:', e);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
        <body style="font-family: sans-serif; padding: 40px; text-align: center; background: #1a1a2e; color: #fff;">
          <h1>⚠️ Error</h1>
          <p style="color: #f87171;">${e.message}</p>
          <a href="/" style="color: #6366f1;">← Back</a>
        </body>
        </html>
      `);
    }
    return;
  }

  // 404 for everything else - CroxyProxy handles resources via its own servers
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found - resources should load from CroxyProxy servers directly');
});

// Cleanup on exit
process.on('SIGINT', async () => {
  console.log('\n[BROWSER] Closing...');
  if (browser) await browser.close();
  process.exit();
});

process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit();
});

// Start server
server.listen(PORT, async () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🌐 CroxyProxy + Playwright                               ║
║                                                            ║
║   Local:  http://localhost:${PORT}                           ║
║                                                            ║
║   ✓ Main page from localhost                               ║
║   ✓ Resources load from CroxyProxy servers                 ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
  `);
  
  // Pre-initialize browser
  await initBrowser();
});
