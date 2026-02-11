/**
 * CroxyProxy Backend Proxy Server
 * 
 * This server acts as a middleman:
 * 1. User's browser only talks to localhost:3000
 * 2. Our server fetches content through CroxyProxy
 * 3. We rewrite CroxyProxy URLs to point back to our server
 * 
 * The browser NEVER directly contacts CroxyProxy
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import zlib from 'zlib';

const PORT = process.env.PORT || 3000;
const CROXY_BASE = 'https://www.croxyproxy.com';

/**
 * Make HTTPS request with proper handling
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
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        ...options.headers
      }
    };

    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        
        // Handle compression
        const encoding = res.headers['content-encoding'];
        if (encoding === 'gzip') {
          zlib.gunzip(buffer, (err, decoded) => {
            if (err) reject(err);
            else resolve({ body: decoded.toString(), headers: res.headers, statusCode: res.statusCode });
          });
        } else if (encoding === 'deflate') {
          zlib.inflate(buffer, (err, decoded) => {
            if (err) reject(err);
            else resolve({ body: decoded.toString(), headers: res.headers, statusCode: res.statusCode });
          });
        } else if (encoding === 'br') {
          zlib.brotliDecompress(buffer, (err, decoded) => {
            if (err) reject(err);
            else resolve({ body: decoded.toString(), headers: res.headers, statusCode: res.statusCode });
          });
        } else {
          resolve({ body: buffer.toString(), headers: res.headers, statusCode: res.statusCode });
        }
      });
    });

    req.on('error', reject);
    
    if (options.body) {
      req.write(options.body);
    }
    
    req.end();
  });
}

/**
 * Fetch the CroxyProxy homepage to get session/CSRF tokens
 */
async function getCroxySession() {
  try {
    const response = await httpsRequest(CROXY_BASE);
    
    // Extract any cookies
    const cookies = response.headers['set-cookie'] || [];
    
    return {
      cookies: cookies.map(c => c.split(';')[0]).join('; '),
      html: response.body
    };
  } catch (e) {
    console.error('Failed to get CroxyProxy session:', e.message);
    return { cookies: '', html: '' };
  }
}

/**
 * Submit URL to CroxyProxy and get proxied content
 */
async function fetchViaCroxy(targetUrl, session) {
  try {
    // CroxyProxy uses a form POST to submit URLs
    const formData = `url=${encodeURIComponent(targetUrl)}`;
    
    const response = await httpsRequest(CROXY_BASE + '/browse.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formData),
        'Cookie': session.cookies,
        'Origin': CROXY_BASE,
        'Referer': CROXY_BASE + '/'
      },
      body: formData
    });

    return response;
  } catch (e) {
    console.error('Failed to fetch via CroxyProxy:', e.message);
    throw e;
  }
}

/**
 * Rewrite CroxyProxy URLs in content to point to our local server
 */
function rewriteCroxyUrls(content, proxyOrigin) {
  // CroxyProxy typically uses URLs like:
  // https://www.croxyproxy.com/browse.php?u=...
  // We need to rewrite these to: http://localhost:3000/browse?u=...
  
  let rewritten = content;
  
  // Replace absolute CroxyProxy URLs
  rewritten = rewritten.replace(
    /https?:\/\/(?:www\.)?croxyproxy\.com/gi,
    proxyOrigin
  );
  
  // Replace any encoded versions
  rewritten = rewritten.replace(
    /https%3A%2F%2F(?:www\.)?croxyproxy\.com/gi,
    encodeURIComponent(proxyOrigin)
  );
  
  return rewritten;
}

/**
 * Main server
 */
const server = http.createServer(async (req, res) => {
  const proxyOrigin = `http://${req.headers.host}`;
  
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  // Handle homepage - show URL input form
  if (req.url === '/' || req.url === '') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>Web Proxy</title>
  <style>
    * { box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      background: rgba(255,255,255,0.1);
      padding: 40px;
      border-radius: 20px;
      backdrop-filter: blur(10px);
      max-width: 600px;
      width: 90%;
    }
    h1 { color: #fff; margin: 0 0 30px; text-align: center; }
    .input-group {
      display: flex;
      gap: 10px;
    }
    input[type="url"] {
      flex: 1;
      padding: 15px 20px;
      border: none;
      border-radius: 10px;
      font-size: 16px;
      background: rgba(255,255,255,0.9);
    }
    button {
      padding: 15px 30px;
      border: none;
      border-radius: 10px;
      background: #4CAF50;
      color: white;
      font-size: 16px;
      cursor: pointer;
      transition: transform 0.2s;
    }
    button:hover { transform: scale(1.05); background: #45a049; }
    .info {
      color: rgba(255,255,255,0.7);
      text-align: center;
      margin-top: 20px;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🌐 Web Proxy</h1>
    <form action="/go" method="GET" class="input-group">
      <input type="url" name="url" placeholder="Enter URL (e.g., https://www.youtube.com)" required>
      <button type="submit">Go</button>
    </form>
    <p class="info">Enter any URL to browse anonymously through the proxy</p>
  </div>
</body>
</html>
    `);
    return;
  }

  // Handle /go?url=... requests
  if (req.url.startsWith('/go?')) {
    const urlParams = new URLSearchParams(req.url.slice(4));
    const targetUrl = urlParams.get('url');
    
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing url parameter');
      return;
    }

    try {
      // Get CroxyProxy session
      const session = await getCroxySession();
      
      // Fetch through CroxyProxy
      const response = await fetchViaCroxy(targetUrl, session);
      
      // Rewrite CroxyProxy URLs to our server
      let content = rewriteCroxyUrls(response.body, proxyOrigin);
      
      // Set response headers
      const contentType = response.headers['content-type'] || 'text/html';
      res.writeHead(response.statusCode || 200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      });
      
      res.end(content);
    } catch (e) {
      console.error('Proxy error:', e);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Proxy error: ' + e.message);
    }
    return;
  }

  // Handle CroxyProxy-style browse requests (for subsequent requests)
  if (req.url.startsWith('/browse')) {
    try {
      // Forward to CroxyProxy
      const croxyUrl = CROXY_BASE + req.url;
      const response = await httpsRequest(croxyUrl, {
        method: req.method,
        headers: {
          'Cookie': req.headers.cookie || ''
        }
      });
      
      let content = rewriteCroxyUrls(response.body, proxyOrigin);
      
      const contentType = response.headers['content-type'] || 'text/html';
      res.writeHead(response.statusCode || 200, {
        'Content-Type': contentType
      });
      
      res.end(content);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error: ' + e.message);
    }
    return;
  }

  // 404 for everything else
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n🚀 Proxy server running at http://localhost:${PORT}`);
  console.log(`\n📝 Usage:`);
  console.log(`   Open http://localhost:${PORT} in your browser`);
  console.log(`   Enter any URL to browse through the proxy`);
  console.log(`\n🔒 Your browser only talks to localhost - never directly to CroxyProxy\n`);
});
