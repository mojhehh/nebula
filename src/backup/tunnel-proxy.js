/**
 * HTTP Proxy that works through Cloudflare Tunnel
 * 
 * This wraps proxy requests in standard HTTP so they work through CF tunnels.
 * 
 * Setup:
 *   1. Run: node src/tunnel-proxy.js
 *   2. Run: cloudflared tunnel --url http://localhost:8888
 *   3. On iPad: Configure proxy to the tunnel URL
 */

const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');

const PORT = 8888;

// Store active CONNECT tunnels
const tunnels = new Map();

const server = http.createServer(async (req, res) => {
  const targetUrl = req.url;
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    return res.end();
  }
  
  // Special endpoint: proxy API for tunneled HTTPS
  if (req.url.startsWith('/proxy/')) {
    return handleProxyRequest(req, res);
  }
  
  // Regular HTTP proxy request (full URL)
  if (targetUrl.startsWith('http://')) {
    return forwardHttpRequest(req, res, targetUrl);
  }
  
  // Serve a simple PAC file or info page
  if (req.url === '/' || req.url === '/pac' || req.url === '/proxy.pac') {
    return servePacFile(req, res);
  }
  
  res.writeHead(400);
  res.end('Invalid proxy request');
});

// Handle CONNECT for HTTPS (won't work through CF tunnel, but works locally)
server.on('connect', (req, clientSocket, head) => {
  const [hostname, port] = req.url.split(':');
  const targetPort = parseInt(port) || 443;
  
  console.log(`[CONNECT] ${hostname}:${targetPort}`);
  
  const serverSocket = net.connect(targetPort, hostname, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });
  
  serverSocket.on('error', (err) => {
    console.error(`[CONNECT ERROR] ${err.message}`);
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  
  clientSocket.on('error', () => serverSocket.destroy());
  serverSocket.on('end', () => clientSocket.end());
  clientSocket.on('end', () => serverSocket.end());
});

function forwardHttpRequest(req, res, targetUrl) {
  console.log(`[HTTP] ${req.method} ${targetUrl}`);
  
  try {
    const parsed = new URL(targetUrl);
    
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers: { ...req.headers }
    };
    
    delete options.headers['proxy-connection'];
    options.headers.host = parsed.host;
    
    const proxyReq = http.request(options, (proxyRes) => {
      // Add CORS headers
      const headers = { ...proxyRes.headers };
      headers['access-control-allow-origin'] = '*';
      
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    });
    
    proxyReq.on('error', (err) => {
      console.error(`[HTTP ERROR] ${err.message}`);
      res.writeHead(502);
      res.end('Bad Gateway');
    });
    
    req.pipe(proxyReq);
  } catch (err) {
    res.writeHead(400);
    res.end('Invalid URL');
  }
}

// Handle /proxy/https/example.com/path style requests
async function handleProxyRequest(req, res) {
  const match = req.url.match(/^\/proxy\/(https?)\/(.*)/);
  if (!match) {
    res.writeHead(400);
    return res.end('Invalid proxy URL format');
  }
  
  const protocol = match[1];
  const rest = match[2];
  const targetUrl = `${protocol}://${rest}`;
  
  console.log(`[PROXY API] ${req.method} ${targetUrl}`);
  
  try {
    const parsed = new URL(targetUrl);
    const isHttps = protocol === 'https';
    const lib = isHttps ? https : http;
    
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers: { ...req.headers }
    };
    
    // Fix headers
    delete options.headers['host'];
    delete options.headers['proxy-connection'];
    options.headers.host = parsed.host;
    
    const proxyReq = lib.request(options, (proxyRes) => {
      const headers = { ...proxyRes.headers };
      headers['access-control-allow-origin'] = '*';
      headers['access-control-expose-headers'] = '*';
      
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    });
    
    proxyReq.on('error', (err) => {
      console.error(`[PROXY ERROR] ${err.message}`);
      res.writeHead(502);
      res.end(`Proxy error: ${err.message}`);
    });
    
    req.pipe(proxyReq);
  } catch (err) {
    res.writeHead(400);
    res.end(`Invalid URL: ${err.message}`);
  }
}

function servePacFile(req, res) {
  // Get the host from request to build PAC file
  const host = req.headers.host || `localhost:${PORT}`;
  
  // Return info page for browser
  if (req.headers.accept?.includes('text/html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>Proxy Server</title>
  <style>
    body { font-family: system-ui; max-width: 800px; margin: 50px auto; padding: 20px; }
    code { background: #f0f0f0; padding: 2px 8px; border-radius: 4px; }
    .box { background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0; }
  </style>
</head>
<body>
  <h1>🌐 Proxy Server Running</h1>
  
  <div class="box">
    <h3>Option 1: Manual Proxy (Same Network)</h3>
    <p>Configure your device's proxy settings:</p>
    <ul>
      <li><strong>Server:</strong> <code>${host.split(':')[0]}</code></li>
      <li><strong>Port:</strong> <code>${PORT}</code></li>
    </ul>
  </div>
  
  <div class="box">
    <h3>Option 2: PAC File (Automatic)</h3>
    <p>Use this URL for automatic proxy configuration:</p>
    <code>http://${host}/proxy.pac</code>
  </div>
  
  <div class="box">
    <h3>Option 3: Direct URL Proxy</h3>
    <p>Access any site through:</p>
    <code>http://${host}/proxy/https/www.tiktok.com/</code>
  </div>
  
  <h3>Test Links:</h3>
  <ul>
    <li><a href="/proxy/https/www.google.com/">Google (via proxy)</a></li>
    <li><a href="/proxy/https/www.tiktok.com/">TikTok (via proxy)</a></li>
    <li><a href="/proxy/https/www.roblox.com/">Roblox (via proxy)</a></li>
  </ul>
</body>
</html>
    `);
  }
  
  // Return actual PAC file
  res.writeHead(200, { 
    'Content-Type': 'application/x-ns-proxy-autoconfig',
    'Content-Disposition': 'attachment; filename="proxy.pac"'
  });
  
  res.end(`
function FindProxyForURL(url, host) {
  // Use this proxy for everything
  return "PROXY ${host}";
}
  `);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║              Tunnel-Compatible Proxy Server                   ║
╠═══════════════════════════════════════════════════════════════╣
║  Running on port ${PORT}                                         ║
║                                                               ║
║  LOCAL USE (same network):                                    ║
║    Proxy: YOUR_PC_IP:${PORT}                                     ║
║                                                               ║
║  REMOTE USE (via Cloudflare Tunnel):                          ║
║    1. Run: cloudflared tunnel --url http://localhost:${PORT}     ║
║    2. Use the tunnel URL directly in browser                  ║
║    3. Access sites via: https://YOUR-TUNNEL/proxy/https/site  ║
║                                                               ║
║  Example URLs through proxy:                                  ║
║    /proxy/https/www.tiktok.com/                               ║
║    /proxy/https/www.roblox.com/                               ║
╚═══════════════════════════════════════════════════════════════╝
`);
});
