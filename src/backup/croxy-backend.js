/**
 * CroxyProxy Backend - Routes through CroxyProxy servers
 * 
 * How CroxyProxy works:
 * 1. Submit URL → croxyproxy.com/servers
 * 2. Get redirected to IP server like: https://51.158.204.28/?__cpo=BASE64_URL
 * 3. Content served from that IP
 * 
 * Our approach:
 * - Browser only talks to localhost:3000
 * - We fetch from CroxyProxy's IP servers
 * - Rewrite all CroxyProxy IPs/URLs to point back to localhost
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import zlib from 'zlib';

const PORT = process.env.PORT || 3000;

// CroxyProxy main domain - we'll discover servers from here
const CROXY_DOMAIN = 'www.croxyproxy.com';

// Known CroxyProxy servers (we'll discover more dynamically)
let CROXY_SERVERS = [
  // These are IPs you found that were working
  '51.158.204.28',
  '108.181.34.157'
];

// Track discovered servers
const discoveredServers = new Set(CROXY_SERVERS);
let lastWorkingServer = null;

// Session cookies
let sessionCookies = '';

/**
 * Base64 encode for CroxyProxy __cpo parameter
 */
function encodeForCroxy(url) {
  return Buffer.from(url).toString('base64');
}

/**
 * Base64 decode from __cpo parameter
 */
function decodeFromCroxy(encoded) {
  try {
    // Handle URL-encoded base64
    const decoded = decodeURIComponent(encoded);
    return Buffer.from(decoded, 'base64').toString('utf-8');
  } catch (e) {
    try {
      return Buffer.from(encoded, 'base64').toString('utf-8');
    } catch (e2) {
      return null;
    }
  }
}

/**
 * Make HTTPS request with full response handling
 */
function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        ...options.headers
      },
      rejectUnauthorized: false, // CroxyProxy uses self-signed certs on IPs
      timeout: 30000
    };

    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      
      // Collect cookies
      if (res.headers['set-cookie']) {
        const newCookies = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
        sessionCookies = newCookies;
      }
      
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        
        // Handle compression
        const encoding = res.headers['content-encoding'];
        
        const decompress = (data) => {
          resolve({ 
            body: data, 
            headers: res.headers, 
            statusCode: res.statusCode,
            finalUrl: url
          });
        };
        
        if (encoding === 'gzip') {
          zlib.gunzip(buffer, (err, decoded) => {
            if (err) resolve({ body: buffer, headers: res.headers, statusCode: res.statusCode });
            else decompress(decoded);
          });
        } else if (encoding === 'deflate') {
          zlib.inflate(buffer, (err, decoded) => {
            if (err) resolve({ body: buffer, headers: res.headers, statusCode: res.statusCode });
            else decompress(decoded);
          });
        } else if (encoding === 'br') {
          zlib.brotliDecompress(buffer, (err, decoded) => {
            if (err) resolve({ body: buffer, headers: res.headers, statusCode: res.statusCode });
            else decompress(decoded);
          });
        } else {
          decompress(buffer);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    if (options.body) {
      req.write(options.body);
    }
    
    req.end();
  });
}

/**
 * Pick a random CroxyProxy server
 */
function pickServer() {
  // Prefer last working server
  if (lastWorkingServer && discoveredServers.has(lastWorkingServer)) {
    return lastWorkingServer;
  }
  const servers = Array.from(discoveredServers);
  return servers[Math.floor(Math.random() * servers.length)];
}

/**
 * Go through CroxyProxy.com to get redirected to a working server
 */
async function discoverServerViaCroxy(targetUrl) {
  console.log('[CROXY] Discovering server via croxyproxy.com...');
  
  try {
    // First, get the main page to get cookies/session
    const mainPage = await httpsRequest(`https://${CROXY_DOMAIN}/`, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    
    // Now submit the URL to their servers endpoint
    const formData = `url=${encodeURIComponent(targetUrl)}&server=`;
    
    const response = await httpsRequest(`https://${CROXY_DOMAIN}/servers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formData),
        'Cookie': sessionCookies,
        'Origin': `https://${CROXY_DOMAIN}`,
        'Referer': `https://${CROXY_DOMAIN}/`
      },
      body: formData
    });
    
    // Check for redirect or server IP in response
    const body = response.body.toString();
    
    // Look for IP addresses in the response
    const ipMatches = body.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g);
    if (ipMatches) {
      for (const ip of ipMatches) {
        if (!ip.startsWith('127.') && !ip.startsWith('0.') && !ip.startsWith('192.168.')) {
          console.log(`[CROXY] Discovered server: ${ip}`);
          discoveredServers.add(ip);
          lastWorkingServer = ip;
        }
      }
    }
    
    // Look for __cpo URLs with server
    const cpoMatch = body.match(/https?:\/\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[^"'\s]*__cpo/);
    if (cpoMatch) {
      console.log(`[CROXY] Found server in __cpo URL: ${cpoMatch[1]}`);
      discoveredServers.add(cpoMatch[1]);
      lastWorkingServer = cpoMatch[1];
      return cpoMatch[1];
    }
    
    return lastWorkingServer || pickServer();
  } catch (e) {
    console.error('[CROXY] Discovery failed:', e.message);
    return pickServer();
  }
}

/**
 * Fetch URL through CroxyProxy server
 */
async function fetchViaCroxy(targetUrl) {
  const server = pickServer();
  const encodedUrl = encodeForCroxy(targetUrl);
  const croxyUrl = `https://${server}/?__cpo=${encodedUrl}`;
  
  console.log(`[CROXY] Using server: ${server}`);
  console.log(`[CROXY] Target: ${targetUrl}`);
  
  try {
    const response = await httpsRequest(croxyUrl, {
      headers: {
        'Cookie': sessionCookies,
        'Referer': `https://${server}/`
      }
    });
    
    return response;
  } catch (e) {
    console.error(`[CROXY] Server ${server} failed:`, e.message);
    
    // Try another server
    discoveredServers.delete(server);
    if (discoveredServers.size > 0) {
      return fetchViaCroxy(targetUrl);
    }
    throw e;
  }
}

/**
 * Rewrite CroxyProxy URLs/IPs to our local server
 */
function rewriteContent(content, proxyOrigin) {
  if (!content || !Buffer.isBuffer(content)) {
    content = Buffer.from(content || '');
  }
  
  let text = content.toString('utf-8');
  
  // Replace all known CroxyProxy server IPs
  for (const server of discoveredServers) {
    // https://IP
    text = text.replace(
      new RegExp(`https?://${server.replace(/\./g, '\\.')}`, 'gi'),
      proxyOrigin
    );
    // Just the IP in URLs
    text = text.replace(
      new RegExp(`//${server.replace(/\./g, '\\.')}`, 'gi'),
      `//${proxyOrigin.replace(/^https?:\/\//, '')}`
    );
  }
  
  // Replace croxyproxy.com references
  text = text.replace(/https?:\/\/(?:www\.)?croxyproxy\.com/gi, proxyOrigin);
  
  // Replace __cpo parameters with our /browse/ format
  // Pattern: ?__cpo=BASE64 → /browse/BASE64
  text = text.replace(
    /\?__cpo=([A-Za-z0-9+/=_%]+)/gi,
    (match, encoded) => `/browse/${encoded}`
  );
  
  // Handle __cpi.php URLs - convert to our format
  text = text.replace(
    /\/__cpi\.php\?[^"'\s]*/gi,
    (match) => {
      // Extract what we can and convert
      const urlMatch = match.match(/__cpo=([A-Za-z0-9+/=_%]+)/);
      if (urlMatch) {
        return `/browse/${urlMatch[1]}`;
      }
      return match;
    }
  );
  
  return text;
}

/**
 * Extract target URL from our path formats
 */
function extractTargetUrl(path) {
  // Format: /browse/BASE64_URL
  if (path.startsWith('/browse/')) {
    const encoded = path.slice('/browse/'.length).split('?')[0].split('/')[0];
    return decodeFromCroxy(encoded);
  }
  
  // Format: /go?url=URL
  if (path.startsWith('/go?')) {
    const params = new URLSearchParams(path.slice(4));
    return params.get('url');
  }
  
  // Format: ?__cpo=BASE64
  if (path.includes('__cpo=')) {
    const match = path.match(/__cpo=([A-Za-z0-9+/=_%]+)/);
    if (match) {
      return decodeFromCroxy(match[1]);
    }
  }
  
  return null;
}

/**
 * Main server
 */
const server = http.createServer(async (req, res) => {
  const proxyOrigin = `http://${req.headers.host}`;
  
  console.log(`\n[${new Date().toISOString()}] ${req.method} ${req.url}`);

  // CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Homepage
  if (req.url === '/' || req.url === '') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>🌐 Web Proxy</title>
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
    h1 { 
      color: #fff; 
      margin-bottom: 10px; 
      text-align: center;
      font-size: 2.5em;
    }
    .subtitle {
      color: rgba(255,255,255,0.6);
      text-align: center;
      margin-bottom: 40px;
      font-size: 1.1em;
    }
    form {
      display: flex;
      gap: 12px;
    }
    input[type="url"] {
      flex: 1;
      padding: 18px 24px;
      border: 2px solid rgba(255,255,255,0.1);
      border-radius: 14px;
      font-size: 16px;
      background: rgba(0,0,0,0.3);
      color: #fff;
      outline: none;
      transition: all 0.3s;
    }
    input[type="url"]:focus {
      border-color: #6366f1;
      background: rgba(0,0,0,0.5);
    }
    input[type="url"]::placeholder {
      color: rgba(255,255,255,0.4);
    }
    button {
      padding: 18px 36px;
      border: none;
      border-radius: 14px;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      color: white;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s;
    }
    button:hover { 
      transform: translateY(-2px);
      box-shadow: 0 10px 30px rgba(99,102,241,0.4);
    }
    .quick-links {
      display: flex;
      gap: 10px;
      margin-top: 30px;
      justify-content: center;
      flex-wrap: wrap;
    }
    .quick-link {
      padding: 10px 20px;
      background: rgba(255,255,255,0.1);
      border-radius: 20px;
      color: rgba(255,255,255,0.8);
      text-decoration: none;
      font-size: 14px;
      transition: all 0.3s;
    }
    .quick-link:hover {
      background: rgba(255,255,255,0.2);
      color: #fff;
    }
    .info {
      color: rgba(255,255,255,0.5);
      text-align: center;
      margin-top: 30px;
      font-size: 13px;
      line-height: 1.6;
    }
    .info strong { color: #6366f1; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🌐 Web Proxy</h1>
    <p class="subtitle">Browse any website anonymously</p>
    
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
      Your browser <strong>only connects to localhost</strong><br>
      All traffic is routed through external proxy servers
    </p>
  </div>
</body>
</html>
    `);
    return;
  }

  // Handle proxy requests
  const targetUrl = extractTargetUrl(req.url);
  
  if (targetUrl) {
    console.log(`[PROXY] Target URL: ${targetUrl}`);
    
    try {
      const response = await fetchViaCroxy(targetUrl);
      
      // Determine content type
      const contentType = response.headers['content-type'] || 'text/html';
      const isText = contentType.includes('text') || 
                     contentType.includes('javascript') || 
                     contentType.includes('json') ||
                     contentType.includes('xml');
      
      // Build response headers
      const headers = {
        'Content-Type': contentType
      };
      
      // Copy some headers
      if (response.headers['content-disposition']) {
        headers['Content-Disposition'] = response.headers['content-disposition'];
      }
      
      let body = response.body;
      
      // Rewrite text content
      if (isText) {
        body = rewriteContent(body, proxyOrigin);
      }
      
      res.writeHead(response.statusCode || 200, headers);
      res.end(body);
      
    } catch (e) {
      console.error('[PROXY] Error:', e.message);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
        <head><title>Proxy Error</title></head>
        <body style="font-family: sans-serif; padding: 40px; text-align: center;">
          <h1>⚠️ Proxy Error</h1>
          <p>${e.message}</p>
          <a href="/">← Back to home</a>
        </body>
        </html>
      `);
    }
    return;
  }

  // Try to handle as a relative URL from a proxied page
  // Check referer to see what site we're on
  const referer = req.headers.referer;
  if (referer) {
    const refererTarget = extractTargetUrl(new URL(referer).pathname);
    if (refererTarget) {
      try {
        const baseUrl = new URL(refererTarget);
        const fullUrl = new URL(req.url, baseUrl.origin).href;
        
        console.log(`[PROXY] Relative URL resolved: ${fullUrl}`);
        
        const response = await fetchViaCroxy(fullUrl);
        const contentType = response.headers['content-type'] || 'application/octet-stream';
        
        const isText = contentType.includes('text') || 
                       contentType.includes('javascript') || 
                       contentType.includes('json');
        
        let body = response.body;
        if (isText) {
          body = rewriteContent(body, proxyOrigin);
        }
        
        res.writeHead(response.statusCode || 200, { 'Content-Type': contentType });
        res.end(body);
        return;
      } catch (e) {
        console.error('[PROXY] Relative URL error:', e.message);
      }
    }
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found: ' + req.url);
});

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🌐 Web Proxy Server Running                              ║
║                                                            ║
║   Local:  http://localhost:${PORT}                           ║
║                                                            ║
║   Your browser ONLY talks to localhost                     ║
║   Traffic routed through external proxy servers            ║
║                                                            ║
║   Available Servers: ${discoveredServers.size}                                ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
  `);
});
