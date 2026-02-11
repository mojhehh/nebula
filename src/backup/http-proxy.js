/**
 * Simple HTTP/HTTPS Forward Proxy
 * Configure this in your device's WiFi proxy settings
 * 
 * Usage:
 *   1. Run: node src/http-proxy.js
 *   2. On iPad: Settings > WiFi > (i) > Configure Proxy > Manual
 *      - Server: your-server-ip (or cloudflare tunnel domain)
 *      - Port: 8080
 *   3. All traffic now goes through this proxy
 */

const http = require('http');
const https = require('https');
const net = require('net');
const url = require('url');

const PORT = process.env.PROXY_PORT || 8080;

// Optional: Add blocked domain bypass (domains that should be allowed)
const ALWAYS_ALLOW = [
  'tiktok.com',
  'www.tiktok.com',
  'roblox.com',
  'www.roblox.com',
  'now.gg',
  'www.now.gg',
  'nowgg.me',
  'discord.com',
  'www.discord.com',
  'twitch.tv',
  'www.twitch.tv',
  'youtube.com',
  'www.youtube.com',
  'spotify.com',
  'open.spotify.com'
];

// Create the proxy server
const server = http.createServer((req, res) => {
  // Handle regular HTTP requests
  const parsedUrl = url.parse(req.url);
  
  console.log(`[HTTP] ${req.method} ${req.url}`);
  
  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || 80,
    path: parsedUrl.path,
    method: req.method,
    headers: { ...req.headers }
  };
  
  // Remove proxy-specific headers
  delete options.headers['proxy-connection'];
  
  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  
  proxyReq.on('error', (err) => {
    console.error(`[HTTP ERROR] ${err.message}`);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway');
  });
  
  req.pipe(proxyReq);
});

// Handle HTTPS CONNECT requests (tunnel)
server.on('connect', (req, clientSocket, head) => {
  const [hostname, port] = req.url.split(':');
  const targetPort = parseInt(port) || 443;
  
  console.log(`[HTTPS] CONNECT ${hostname}:${targetPort}`);
  
  const serverSocket = net.connect(targetPort, hostname, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    
    if (head.length > 0) {
      serverSocket.write(head);
    }
    
    // Create bidirectional tunnel
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });
  
  serverSocket.on('error', (err) => {
    console.error(`[HTTPS ERROR] ${hostname}:${targetPort} - ${err.message}`);
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    clientSocket.end();
  });
  
  clientSocket.on('error', (err) => {
    console.error(`[CLIENT ERROR] ${err.message}`);
    serverSocket.destroy();
  });
  
  serverSocket.on('end', () => clientSocket.end());
  clientSocket.on('end', () => serverSocket.end());
});

server.on('error', (err) => {
  console.error('[SERVER ERROR]', err);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           HTTP/HTTPS Forward Proxy Server                    ║
╠══════════════════════════════════════════════════════════════╣
║  Proxy running on port ${PORT}                                  ║
║                                                              ║
║  Configure on your device:                                   ║
║  ─────────────────────────────────────────────────────────   ║
║  iPad/iPhone:                                                ║
║    Settings > WiFi > (i) > Configure Proxy > Manual          ║
║    Server: YOUR_SERVER_IP                                    ║
║    Port: ${PORT}                                                ║
║                                                              ║
║  Android:                                                    ║
║    Settings > WiFi > Long press network > Modify > Proxy     ║
║    Manual > Hostname: YOUR_SERVER_IP, Port: ${PORT}             ║
║                                                              ║
║  Windows:                                                    ║
║    Settings > Network > Proxy > Manual proxy setup           ║
║    Address: YOUR_SERVER_IP, Port: ${PORT}                       ║
║                                                              ║
║  For Cloudflare Tunnel:                                      ║
║    cloudflared tunnel --url http://localhost:${PORT}            ║
║    Then use the tunnel URL as proxy server                   ║
╚══════════════════════════════════════════════════════════════╝
`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down proxy...');
  server.close(() => process.exit(0));
});
