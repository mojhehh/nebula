/**
 * Web Proxy Rewriter Server
 * 
 * Architecture:
 * - All requests come to this server with the target URL encoded in the path
 * - HTML responses are rewritten to route all URLs through the proxy
 * - Non-HTML assets are streamed byte-for-byte with correct MIME types
 * - A runtime script is injected to intercept dynamic URL creation
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { rewriteHtml } from './html-rewriter.js';
import { rewriteCss } from './css-rewriter.js';
import { 
  encodeProxyUrl, 
  decodeProxyUrl, 
  getProxyOrigin,
  isAbsoluteUrl,
  resolveUrl 
} from './url-utils.js';
import { getRuntimeScript } from './runtime-inject.js';
import { handleCookies, rewriteSetCookieHeader } from './cookie-handler.js';

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';

// MIME type mappings for strict type safety
const MIME_OVERRIDES = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.cjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4s': 'video/iso.segment',
  '.ts': 'video/mp2t',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
};

// Content types that should be rewritten
const REWRITABLE_HTML_TYPES = [
  'text/html',
  'application/xhtml+xml',
];

const REWRITABLE_CSS_TYPES = [
  'text/css',
];

/**
 * Determine if content type indicates HTML
 */
function isHtmlContentType(contentType) {
  if (!contentType) return false;
  const mimeType = contentType.split(';')[0].trim().toLowerCase();
  return REWRITABLE_HTML_TYPES.includes(mimeType);
}

/**
 * Determine if content type indicates CSS
 */
function isCssContentType(contentType) {
  if (!contentType) return false;
  const mimeType = contentType.split(';')[0].trim().toLowerCase();
  return REWRITABLE_CSS_TYPES.includes(mimeType);
}

/**
 * Get correct MIME type based on URL extension
 * This ensures Safari and other strict browsers get correct types
 */
function getCorrectMimeType(url, originalContentType) {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.substring(pathname.lastIndexOf('.')).toLowerCase();
    
    if (MIME_OVERRIDES[ext]) {
      return MIME_OVERRIDES[ext];
    }
  } catch (e) {
    // Ignore URL parsing errors
  }
  
  return originalContentType;
}

/**
 * Create the HTTP(S) request options for upstream
 */
function createUpstreamRequest(targetUrl, clientReq, proxyOrigin) {
  const parsed = new URL(targetUrl);
  const isHttps = parsed.protocol === 'https:';
  
  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: clientReq.method,
    headers: { ...clientReq.headers },
  };
  
  // Fix headers for upstream
  options.headers.host = parsed.host;
  delete options.headers['accept-encoding']; // We need to read the body for rewriting
  
  // Handle referer
  if (options.headers.referer) {
    try {
      const refererDecoded = decodeProxyUrl(options.headers.referer, proxyOrigin);
      if (refererDecoded) {
        options.headers.referer = refererDecoded;
      }
    } catch (e) {
      delete options.headers.referer;
    }
  }
  
  // Handle origin header for CORS
  if (options.headers.origin) {
    options.headers.origin = parsed.origin;
  }
  
  return { options, isHttps, targetOrigin: parsed.origin };
}

/**
 * Stream response with proper headers
 */
function streamResponse(clientRes, upstreamRes, targetUrl, proxyOrigin, rewrite = false, rewriteFn = null, requestOrigin = null) {
  const headers = { ...upstreamRes.headers };
  
  // Fix content type for strict MIME safety
  if (headers['content-type']) {
    headers['content-type'] = getCorrectMimeType(targetUrl, headers['content-type']);
  }
  
  // Rewrite Set-Cookie headers
  if (headers['set-cookie']) {
    headers['set-cookie'] = rewriteSetCookieHeader(headers['set-cookie'], targetUrl, proxyOrigin);
  }
  
  // Remove problematic headers
  delete headers['content-security-policy'];
  delete headers['content-security-policy-report-only'];
  delete headers['x-frame-options'];
  delete headers['strict-transport-security'];
  
  // Fix CORS for proxy
  // IMPORTANT: When credentials are included, we MUST echo back the specific origin
  // Using wildcard (*) with credentials causes browsers to block the response
  if (requestOrigin && requestOrigin !== 'null') {
    headers['access-control-allow-origin'] = requestOrigin;
    headers['access-control-allow-credentials'] = 'true';
  } else {
    headers['access-control-allow-origin'] = '*';
    // Cannot use credentials with wildcard
    delete headers['access-control-allow-credentials'];
  }
  headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS, HEAD';
  headers['access-control-allow-headers'] = '*';
  headers['access-control-expose-headers'] = '*';
  
  if (rewrite && rewriteFn) {
    // Buffer and rewrite content
    delete headers['content-length']; // Length will change
    delete headers['content-encoding'];
    
    const chunks = [];
    upstreamRes.on('data', chunk => chunks.push(chunk));
    upstreamRes.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      const rewritten = rewriteFn(body, targetUrl, proxyOrigin);
      
      headers['content-length'] = Buffer.byteLength(rewritten);
      clientRes.writeHead(upstreamRes.statusCode, headers);
      clientRes.end(rewritten);
    });
  } else {
    // Stream byte-for-byte
    clientRes.writeHead(upstreamRes.statusCode, headers);
    upstreamRes.pipe(clientRes);
  }
}

/**
 * Handle proxy request
 */
async function handleRequest(clientReq, clientRes) {
  const proxyOrigin = getProxyOrigin(clientReq);
  
  // Handle CORS preflight
  const requestOrigin = clientReq.headers.origin;
  if (clientReq.method === 'OPTIONS') {
    const corsHeaders = {
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD',
      'access-control-allow-headers': '*',
      'access-control-expose-headers': '*',
      'access-control-max-age': '86400',
    };
    // Echo back origin when present (for credentials mode)
    if (requestOrigin && requestOrigin !== 'null') {
      corsHeaders['access-control-allow-origin'] = requestOrigin;
      corsHeaders['access-control-allow-credentials'] = 'true';
    } else {
      corsHeaders['access-control-allow-origin'] = '*';
    }
    clientRes.writeHead(200, corsHeaders);
    clientRes.end();
    return;
  }
  
  // Serve runtime script
  if (clientReq.url === '/__proxy__/runtime.js') {
    const script = getRuntimeScript(proxyOrigin);
    clientRes.writeHead(200, {
      'content-type': 'application/javascript',
      'content-length': Buffer.byteLength(script),
      'cache-control': 'public, max-age=3600',
    });
    clientRes.end(script);
    return;
  }
  
  // Decode target URL from request path
  let targetUrl = decodeProxyUrl(clientReq.url, proxyOrigin);
  
  // Handle relative URLs from proxied pages (fallback)
  // These come from requests that the runtime script missed (including POST/API calls)
  if (!targetUrl && !clientReq.url.startsWith('/proxy/') && clientReq.url !== '/') {
    // Check referer to determine the target origin
    const referer = clientReq.headers.referer;
    if (referer) {
      const refererTarget = decodeProxyUrl(referer, proxyOrigin);
      if (refererTarget) {
        try {
          const refererOrigin = new URL(refererTarget).origin;
          targetUrl = refererOrigin + clientReq.url;
          console.log(`[PROXY] Fallback (${clientReq.method}): ${clientReq.url} -> ${targetUrl}`);
        } catch (e) {}
      }
    }
    
    // If no referer, check for common YouTube API paths and default to youtube.com
    if (!targetUrl && (clientReq.url.startsWith('/youtubei/') || 
                       clientReq.url.startsWith('/s/') ||
                       clientReq.url.startsWith('/api/') ||
                       clientReq.url.startsWith('/generate_204'))) {
      targetUrl = 'https://www.youtube.com' + clientReq.url;
      console.log(`[PROXY] YouTube fallback (${clientReq.method}): ${clientReq.url} -> ${targetUrl}`);
    }
  }
  
  if (!targetUrl) {
    // Serve homepage
    clientRes.writeHead(200, { 'content-type': 'text/html' });
    clientRes.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Web Proxy</title>
  <style>
    * { box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 600px; 
      margin: 50px auto; 
      padding: 20px;
      background: #f5f5f5;
    }
    h1 { color: #333; }
    form { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    input[type="url"] { 
      width: 100%; 
      padding: 12px; 
      font-size: 16px; 
      border: 1px solid #ddd;
      border-radius: 4px;
      margin-bottom: 10px;
    }
    button { 
      width: 100%;
      padding: 12px 24px; 
      font-size: 16px; 
      background: #007bff; 
      color: white; 
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    button:hover { background: #0056b3; }
    .examples { margin-top: 20px; }
    .examples a { display: block; margin: 5px 0; color: #007bff; }
  </style>
</head>
<body>
  <h1>🌐 Web Proxy</h1>
  <form onsubmit="go(event)">
    <input type="url" id="url" placeholder="https://www.youtube.com" required>
    <button type="submit">Browse</button>
  </form>
  <div class="examples">
    <strong>Examples:</strong>
    <a href="#" onclick="navigate('https://www.youtube.com')">YouTube</a>
    <a href="#" onclick="navigate('https://en.wikipedia.org')">Wikipedia</a>
    <a href="#" onclick="navigate('https://news.ycombinator.com')">Hacker News</a>
  </div>
  <script>
    function navigate(url) {
      window.location.href = '${proxyOrigin}/proxy/' + encodeURIComponent(url);
      return false;
    }
    function go(e) {
      e.preventDefault();
      navigate(document.getElementById('url').value);
    }
  </script>
</body>
</html>`);
    return;
  }
  
  console.log(`[PROXY] ${clientReq.method} ${targetUrl}`);
  
  try {
    const { options, isHttps, targetOrigin } = createUpstreamRequest(targetUrl, clientReq, proxyOrigin);
    const httpModule = isHttps ? https : http;
    
    const upstreamReq = httpModule.request(options, (upstreamRes) => {
      // Handle redirects
      if (upstreamRes.statusCode >= 300 && upstreamRes.statusCode < 400 && upstreamRes.headers.location) {
        const redirectUrl = resolveUrl(upstreamRes.headers.location, targetUrl);
        const proxyRedirect = encodeProxyUrl(redirectUrl, proxyOrigin);
        
        clientRes.writeHead(upstreamRes.statusCode, {
          ...upstreamRes.headers,
          location: proxyRedirect,
        });
        clientRes.end();
        return;
      }
      
      const contentType = upstreamRes.headers['content-type'] || '';
      
      if (isHtmlContentType(contentType)) {
        // Rewrite HTML
        streamResponse(clientRes, upstreamRes, targetUrl, proxyOrigin, true, 
          (html, url, origin) => rewriteHtml(html, url, origin), requestOrigin);
      } else if (isCssContentType(contentType)) {
        // Rewrite CSS
        streamResponse(clientRes, upstreamRes, targetUrl, proxyOrigin, true,
          (css, url, origin) => rewriteCss(css, url, origin), requestOrigin);
      } else {
        // Stream asset byte-for-byte with correct MIME type
        streamResponse(clientRes, upstreamRes, targetUrl, proxyOrigin, false, null, requestOrigin);
      }
    });
    
    upstreamReq.on('error', (err) => {
      console.error(`[ERROR] Upstream request failed: ${err.message}`);
      clientRes.writeHead(502, { 'content-type': 'text/plain' });
      clientRes.end(`Proxy error: ${err.message}`);
    });
    
    // Forward request body
    clientReq.pipe(upstreamReq);
    
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    clientRes.writeHead(500, { 'content-type': 'text/plain' });
    clientRes.end(`Server error: ${err.message}`);
  }
}

// Create and start server
const server = http.createServer(handleRequest);

server.listen(PORT, HOST, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                    Web Proxy Rewriter                      ║
╠════════════════════════════════════════════════════════════╣
║  Server running at: http://${HOST}:${PORT}                    ║
║                                                            ║
║  Usage:                                                    ║
║  • Open http://${HOST}:${PORT} in your browser               ║
║  • Enter a URL to browse through the proxy                 ║
║                                                            ║
║  Direct URL format:                                        ║
║  http://${HOST}:${PORT}/proxy/{encoded-url}                  ║
╚════════════════════════════════════════════════════════════╝
  `);
});
