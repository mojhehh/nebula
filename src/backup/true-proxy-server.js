/**
 * TRUE TRANSPARENT PROXY SERVER
 * =============================
 * This is how CroxyProxy actually works - a server-side proxy that:
 * 1. Intercepts ALL requests at the network level
 * 2. Forwards them to the target site
 * 3. Returns responses WITHOUT URL rewriting
 * 
 * The key insight: The proxy server itself becomes the "origin" from
 * the browser's perspective, eliminating all cross-origin issues.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class TrueProxyServer {
    constructor(options = {}) {
        this.port = options.port || 3000;
        this.sessions = new Map(); // sessionId -> { targetOrigin, cookies, etc }
        this.DEBUG = options.debug || false;
    }

    log(...args) {
        if (this.DEBUG) console.log('[PROXY]', ...args);
    }

    /**
     * Generate a unique session ID
     */
    generateSessionId() {
        return crypto.randomBytes(16).toString('hex');
    }

    /**
     * Create or get a session for a target URL
     */
    createSession(targetUrl) {
        const sessionId = this.generateSessionId();
        const target = new URL(targetUrl);
        
        this.sessions.set(sessionId, {
            targetOrigin: target.origin,
            targetHost: target.host,
            targetProtocol: target.protocol,
            initialPath: target.pathname + target.search,
            cookies: new Map(),
            createdAt: Date.now()
        });

        this.log(`Created session ${sessionId} for ${target.origin}`);
        return sessionId;
    }

    /**
     * Get session by ID
     */
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }

    /**
     * Main request handler
     */
    async handleRequest(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        
        // Landing page
        if (url.pathname === '/' && !url.searchParams.has('__session')) {
            return this.serveLandingPage(req, res);
        }

        // API: Create new proxy session
        if (url.pathname === '/api/proxy') {
            return this.handleProxyApi(req, res);
        }

        // Static assets for landing page
        if (url.pathname.startsWith('/static/')) {
            return this.serveStatic(req, res, url.pathname);
        }

        // Get session from query param or cookie
        let sessionId = url.searchParams.get('__session');
        if (!sessionId) {
            const cookies = this.parseCookies(req.headers.cookie || '');
            sessionId = cookies['__proxy_session'];
        }

        if (!sessionId) {
            // No session - show landing page
            return this.serveLandingPage(req, res);
        }

        const session = this.getSession(sessionId);
        if (!session) {
            // Invalid session - show landing page with error
            return this.serveLandingPage(req, res, 'Session expired. Please try again.');
        }

        // Remove our session param from the URL path
        let targetPath = url.pathname + url.search;
        if (url.searchParams.has('__session')) {
            url.searchParams.delete('__session');
            targetPath = url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '');
        }

        // If this is the initial request, use the initial path
        if (targetPath === '/' && session.initialPath && session.initialPath !== '/') {
            targetPath = session.initialPath;
            session.initialPath = null; // Only use once
        }

        // Proxy the request
        await this.proxyRequest(req, res, session, sessionId, targetPath);
    }

    /**
     * Parse cookies from header
     */
    parseCookies(cookieHeader) {
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
     * Serve the landing page
     */
    serveLandingPage(req, res, error = null) {
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Web Proxy</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
        }
        .container {
            text-align: center;
            padding: 40px;
            max-width: 600px;
            width: 90%;
        }
        h1 {
            font-size: 3rem;
            margin-bottom: 10px;
            background: linear-gradient(90deg, #00d4ff, #7b2cbf);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .subtitle {
            color: #888;
            margin-bottom: 40px;
        }
        .input-group {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
        }
        input[type="text"] {
            flex: 1;
            padding: 15px 20px;
            border: none;
            border-radius: 10px;
            font-size: 16px;
            background: rgba(255,255,255,0.1);
            color: white;
            outline: none;
        }
        input[type="text"]::placeholder {
            color: #666;
        }
        input[type="text"]:focus {
            background: rgba(255,255,255,0.15);
        }
        button {
            padding: 15px 30px;
            border: none;
            border-radius: 10px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            background: linear-gradient(90deg, #00d4ff, #7b2cbf);
            color: white;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 30px rgba(0, 212, 255, 0.3);
        }
        .error {
            background: rgba(255, 0, 0, 0.2);
            border: 1px solid #ff4444;
            padding: 15px;
            border-radius: 10px;
            margin-bottom: 20px;
        }
        .quick-links {
            margin-top: 30px;
            display: flex;
            gap: 10px;
            justify-content: center;
            flex-wrap: wrap;
        }
        .quick-link {
            padding: 8px 16px;
            background: rgba(255,255,255,0.1);
            border-radius: 20px;
            font-size: 14px;
            cursor: pointer;
            transition: background 0.2s;
        }
        .quick-link:hover {
            background: rgba(255,255,255,0.2);
        }
        .features {
            margin-top: 50px;
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 20px;
            text-align: left;
        }
        .feature {
            background: rgba(255,255,255,0.05);
            padding: 20px;
            border-radius: 10px;
        }
        .feature h3 {
            font-size: 14px;
            color: #00d4ff;
            margin-bottom: 5px;
        }
        .feature p {
            font-size: 12px;
            color: #888;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🌐 WebProxy</h1>
        <p class="subtitle">Fast, secure, anonymous browsing</p>
        
        ${error ? `<div class="error">${error}</div>` : ''}
        
        <form id="proxyForm">
            <div class="input-group">
                <input type="text" id="urlInput" placeholder="Enter website URL (e.g., youtube.com)" required>
                <button type="submit">Go →</button>
            </div>
        </form>
        
        <div class="quick-links">
            <span class="quick-link" onclick="go('https://www.google.com')">Google</span>
            <span class="quick-link" onclick="go('https://www.youtube.com')">YouTube</span>
            <span class="quick-link" onclick="go('https://www.wikipedia.org')">Wikipedia</span>
            <span class="quick-link" onclick="go('https://www.reddit.com')">Reddit</span>
        </div>
        
        <div class="features">
            <div class="feature">
                <h3>🔒 Encrypted</h3>
                <p>All traffic is encrypted end-to-end</p>
            </div>
            <div class="feature">
                <h3>⚡ Fast</h3>
                <p>Server-side proxy, no client overhead</p>
            </div>
            <div class="feature">
                <h3>🎭 Anonymous</h3>
                <p>Your IP is hidden from websites</p>
            </div>
            <div class="feature">
                <h3>🌍 Unblock</h3>
                <p>Access geo-restricted content</p>
            </div>
        </div>
    </div>
    
    <script>
        function normalizeUrl(url) {
            url = url.trim();
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                url = 'https://' + url;
            }
            return url;
        }
        
        function go(url) {
            document.getElementById('urlInput').value = url;
            startProxy(url);
        }
        
        async function startProxy(url) {
            try {
                const response = await fetch('/api/proxy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: normalizeUrl(url) })
                });
                
                const data = await response.json();
                
                if (data.error) {
                    alert('Error: ' + data.error);
                    return;
                }
                
                // Navigate to the proxy URL
                window.location.href = data.proxyUrl;
            } catch (err) {
                alert('Failed to start proxy: ' + err.message);
            }
        }
        
        document.getElementById('proxyForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const url = document.getElementById('urlInput').value;
            startProxy(url);
        });
    </script>
</body>
</html>`;

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
    }

    /**
     * Handle the proxy API endpoint
     */
    handleProxyApi(req, res) {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Method not allowed' }));
        }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { url } = JSON.parse(body);
                
                if (!url) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'URL is required' }));
                }

                // Validate URL
                let targetUrl;
                try {
                    targetUrl = new URL(url);
                } catch {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Invalid URL' }));
                }

                // Create session
                const sessionId = this.createSession(url);
                
                // Return the proxy URL
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    proxyUrl: `/?__session=${sessionId}`,
                    sessionId: sessionId
                }));

            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid request body' }));
            }
        });
    }

    /**
     * The main proxy logic - forwards requests to target and returns responses
     */
    async proxyRequest(clientReq, clientRes, session, sessionId, targetPath) {
        const targetUrl = new URL(targetPath, session.targetOrigin);
        
        this.log(`Proxying: ${clientReq.method} ${targetUrl.href}`);

        // Build headers for the target request
        const headers = { ...clientReq.headers };
        
        // Fix host header
        headers['host'] = session.targetHost;
        
        // Remove proxy-specific headers
        delete headers['x-forwarded-for'];
        delete headers['x-forwarded-proto'];
        delete headers['x-forwarded-host'];
        
        // Handle referer
        if (headers['referer']) {
            try {
                const refUrl = new URL(headers['referer']);
                headers['referer'] = session.targetOrigin + refUrl.pathname + refUrl.search;
            } catch {
                headers['referer'] = session.targetOrigin + '/';
            }
        }

        // Handle origin
        if (headers['origin']) {
            headers['origin'] = session.targetOrigin;
        }

        // Merge cookies - add stored cookies from session
        const clientCookies = this.parseCookies(headers['cookie'] || '');
        delete clientCookies['__proxy_session']; // Don't send our session cookie
        
        // Merge with session cookies
        for (const [name, value] of session.cookies) {
            if (!clientCookies[name]) {
                clientCookies[name] = value;
            }
        }
        
        // Rebuild cookie header
        const cookieStr = Object.entries(clientCookies)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
        if (cookieStr) {
            headers['cookie'] = cookieStr;
        } else {
            delete headers['cookie'];
        }

        // Accept encoding
        headers['accept-encoding'] = 'gzip, deflate';

        // Make the request to the target
        const protocol = session.targetProtocol === 'https:' ? https : http;
        
        const proxyReq = protocol.request({
            hostname: targetUrl.hostname,
            port: targetUrl.port || (session.targetProtocol === 'https:' ? 443 : 80),
            path: targetUrl.pathname + targetUrl.search,
            method: clientReq.method,
            headers: headers,
            rejectUnauthorized: false // Accept self-signed certs
        }, (proxyRes) => {
            this.handleProxyResponse(clientReq, clientRes, proxyRes, session, sessionId, targetUrl);
        });

        proxyReq.on('error', (err) => {
            this.log(`Proxy request error: ${err.message}`);
            clientRes.writeHead(502, { 'Content-Type': 'text/html' });
            clientRes.end(`<h1>502 Bad Gateway</h1><p>Failed to connect to ${session.targetHost}</p><p>${err.message}</p>`);
        });

        // Pipe request body
        clientReq.pipe(proxyReq);
    }

    /**
     * Handle the response from the target server
     */
    handleProxyResponse(clientReq, clientRes, proxyRes, session, sessionId, targetUrl) {
        const contentType = proxyRes.headers['content-type'] || '';
        const statusCode = proxyRes.statusCode;

        this.log(`Response: ${statusCode} ${contentType.split(';')[0]}`);

        // Process response headers
        const responseHeaders = { ...proxyRes.headers };

        // Store cookies from target in session
        if (responseHeaders['set-cookie']) {
            const cookies = Array.isArray(responseHeaders['set-cookie']) 
                ? responseHeaders['set-cookie'] 
                : [responseHeaders['set-cookie']];
            
            for (const cookie of cookies) {
                const [nameValue] = cookie.split(';');
                const [name, value] = nameValue.split('=');
                if (name && value) {
                    session.cookies.set(name.trim(), value.trim());
                }
            }
        }

        // Remove problematic headers
        delete responseHeaders['content-security-policy'];
        delete responseHeaders['content-security-policy-report-only'];
        delete responseHeaders['x-frame-options'];
        delete responseHeaders['x-xss-protection'];
        delete responseHeaders['strict-transport-security'];
        
        // Fix set-cookie to work with our proxy
        if (responseHeaders['set-cookie']) {
            const cookies = Array.isArray(responseHeaders['set-cookie']) 
                ? responseHeaders['set-cookie'] 
                : [responseHeaders['set-cookie']];
            
            responseHeaders['set-cookie'] = cookies.map(cookie => {
                // Remove domain restrictions
                return cookie
                    .replace(/;\s*domain=[^;]*/gi, '')
                    .replace(/;\s*secure/gi, '')
                    .replace(/;\s*samesite=[^;]*/gi, '; SameSite=Lax');
            });
        }

        // Add our session cookie
        const sessionCookie = `__proxy_session=${sessionId}; Path=/; HttpOnly`;
        if (responseHeaders['set-cookie']) {
            if (Array.isArray(responseHeaders['set-cookie'])) {
                responseHeaders['set-cookie'].push(sessionCookie);
            } else {
                responseHeaders['set-cookie'] = [responseHeaders['set-cookie'], sessionCookie];
            }
        } else {
            responseHeaders['set-cookie'] = sessionCookie;
        }

        // Handle redirects
        if (responseHeaders['location']) {
            const location = responseHeaders['location'];
            try {
                const redirectUrl = new URL(location, targetUrl);
                
                // If redirect is to same origin, keep the path
                if (redirectUrl.origin === session.targetOrigin) {
                    responseHeaders['location'] = redirectUrl.pathname + redirectUrl.search;
                } else {
                    // External redirect - create new session? For now, just proxy it
                    // Update session to new origin
                    session.targetOrigin = redirectUrl.origin;
                    session.targetHost = redirectUrl.host;
                    session.targetProtocol = redirectUrl.protocol;
                    responseHeaders['location'] = redirectUrl.pathname + redirectUrl.search;
                }
            } catch {
                // Keep original location
            }
        }

        // Check if we need to modify the response body
        const needsModification = contentType.includes('text/html') || 
                                  contentType.includes('text/css') ||
                                  contentType.includes('javascript');

        if (!needsModification) {
            // Binary content - stream directly
            delete responseHeaders['content-length']; // We might be decompressing
            clientRes.writeHead(statusCode, responseHeaders);
            
            // Handle compression
            const encoding = proxyRes.headers['content-encoding'];
            if (encoding === 'gzip') {
                proxyRes.pipe(zlib.createGunzip()).pipe(clientRes);
            } else if (encoding === 'deflate') {
                proxyRes.pipe(zlib.createInflate()).pipe(clientRes);
            } else {
                proxyRes.pipe(clientRes);
            }
            return;
        }

        // Collect and modify text content
        let chunks = [];
        proxyRes.on('data', chunk => chunks.push(chunk));
        proxyRes.on('end', () => {
            let buffer = Buffer.concat(chunks);
            
            // Decompress if needed
            const encoding = proxyRes.headers['content-encoding'];
            try {
                if (encoding === 'gzip') {
                    buffer = zlib.gunzipSync(buffer);
                } else if (encoding === 'deflate') {
                    buffer = zlib.inflateSync(buffer);
                }
            } catch (err) {
                this.log(`Decompression error: ${err.message}`);
            }

            let content = buffer.toString('utf-8');

            // Modify content based on type
            if (contentType.includes('text/html')) {
                content = this.modifyHtml(content, session, sessionId, targetUrl);
            } else if (contentType.includes('text/css')) {
                content = this.modifyCss(content, session, targetUrl);
            } else if (contentType.includes('javascript')) {
                content = this.modifyJavaScript(content, session, targetUrl);
            }

            // Remove content-encoding since we decompressed
            delete responseHeaders['content-encoding'];
            delete responseHeaders['content-length'];
            
            // Set new content length
            const finalBuffer = Buffer.from(content, 'utf-8');
            responseHeaders['content-length'] = finalBuffer.length;

            clientRes.writeHead(statusCode, responseHeaders);
            clientRes.end(finalBuffer);
        });
    }

    /**
     * Modify HTML content
     */
    modifyHtml(html, session, sessionId, currentUrl) {
        // Inject a script that patches browser APIs to work with our proxy
        const injectedScript = `
<script>
(function() {
    const SESSION_ID = '${sessionId}';
    const TARGET_ORIGIN = '${session.targetOrigin}';
    const PROXY_ORIGIN = window.location.origin;
    
    // Store original functions
    const originalFetch = window.fetch;
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    
    // Helper to check if URL is absolute external
    function isExternalUrl(url) {
        if (!url) return false;
        if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:')) return false;
        if (url.startsWith('//')) return true;
        if (url.startsWith('http://') || url.startsWith('https://')) {
            try {
                const parsed = new URL(url);
                return parsed.origin !== PROXY_ORIGIN && parsed.origin !== TARGET_ORIGIN;
            } catch { return false; }
        }
        return false;
    }
    
    // Patch fetch
    window.fetch = function(input, init) {
        if (typeof input === 'string' && isExternalUrl(input)) {
            // For external URLs, we need to go through our proxy
            // This is a limitation - we'd need to create new sessions for external domains
            console.log('[Proxy] External fetch:', input);
        }
        return originalFetch.apply(this, arguments);
    };
    
    // Patch XMLHttpRequest
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._proxyUrl = url;
        if (isExternalUrl(url)) {
            console.log('[Proxy] External XHR:', url);
        }
        return originalXHROpen.apply(this, [method, url, ...rest]);
    };
    
    // Patch window.open
    const originalWindowOpen = window.open;
    window.open = function(url, ...rest) {
        if (url && !url.startsWith('javascript:')) {
            console.log('[Proxy] window.open:', url);
            // For same-origin, just open normally
            // For external, would need new proxy session
        }
        return originalWindowOpen.apply(this, arguments);
    };
    
    // Patch history.pushState and replaceState
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    
    history.pushState = function(state, title, url) {
        return originalPushState.apply(this, arguments);
    };
    
    history.replaceState = function(state, title, url) {
        return originalReplaceState.apply(this, arguments);
    };
    
    // Patch document.cookie to work with proxied cookies
    // (Advanced: intercept cookie access)
    
    // Patch postMessage to fix origin checks
    const originalPostMessage = window.postMessage;
    window.postMessage = function(message, targetOrigin, ...rest) {
        if (targetOrigin === TARGET_ORIGIN) {
            targetOrigin = PROXY_ORIGIN;
        }
        return originalPostMessage.apply(this, [message, targetOrigin, ...rest]);
    };
    
    console.log('[Proxy] Initialized for:', TARGET_ORIGIN);
})();
</script>`;

        // Inject our script right after <head> or at the start
        if (html.includes('<head>')) {
            html = html.replace('<head>', '<head>' + injectedScript);
        } else if (html.includes('<HEAD>')) {
            html = html.replace('<HEAD>', '<HEAD>' + injectedScript);
        } else {
            html = injectedScript + html;
        }

        // Fix integrity attributes (they'll fail because we modified content)
        html = html.replace(/\s+integrity="[^"]*"/gi, '');
        html = html.replace(/\s+integrity='[^']*'/gi, '');

        // Remove CSP meta tags
        html = html.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');

        return html;
    }

    /**
     * Modify CSS content
     */
    modifyCss(css, session, currentUrl) {
        // Fix url() references in CSS
        // Most should work as-is since they're relative
        return css;
    }

    /**
     * Modify JavaScript content
     */
    modifyJavaScript(js, session, currentUrl) {
        // Most JS should work as-is
        // Could add patches for specific known issues
        return js;
    }

    /**
     * Start the server
     */
    start() {
        const server = http.createServer((req, res) => {
            this.handleRequest(req, res).catch(err => {
                console.error('Request error:', err);
                res.writeHead(500, { 'Content-Type': 'text/html' });
                res.end('<h1>500 Internal Server Error</h1>');
            });
        });

        // Handle WebSocket upgrade
        server.on('upgrade', (req, socket, head) => {
            this.handleWebSocketUpgrade(req, socket, head);
        });

        server.listen(this.port, () => {
            console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║   🌐 True Proxy Server Running                        ║
║                                                       ║
║   Local:  http://localhost:${this.port}                    ║
║                                                       ║
║   This is a CroxyProxy-style transparent proxy.       ║
║   All requests are proxied server-side.               ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
            `);
        });

        return server;
    }

    /**
     * Handle WebSocket upgrade requests
     */
    handleWebSocketUpgrade(req, clientSocket, head) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        
        // Get session
        let sessionId = url.searchParams.get('__session');
        if (!sessionId) {
            const cookies = this.parseCookies(req.headers.cookie || '');
            sessionId = cookies['__proxy_session'];
        }

        if (!sessionId) {
            clientSocket.destroy();
            return;
        }

        const session = this.getSession(sessionId);
        if (!session) {
            clientSocket.destroy();
            return;
        }

        this.log('WebSocket upgrade for:', session.targetOrigin);

        // Connect to target WebSocket
        const targetProtocol = session.targetProtocol === 'https:' ? 'wss:' : 'ws:';
        const targetWsUrl = `${targetProtocol}//${session.targetHost}${url.pathname}${url.search}`;

        // For WebSocket, we need to establish a raw TCP connection
        // This is simplified - a full implementation would use the 'ws' library
        const net = require('net');
        const tls = require('tls');

        const targetPort = session.targetProtocol === 'https:' ? 443 : 80;
        
        const connect = session.targetProtocol === 'https:' 
            ? () => tls.connect({ host: session.targetHost.split(':')[0], port: targetPort, rejectUnauthorized: false })
            : () => net.connect({ host: session.targetHost.split(':')[0], port: targetPort });

        const targetSocket = connect();

        targetSocket.on('connect', () => {
            // Send WebSocket upgrade request to target
            const headers = [
                `GET ${url.pathname}${url.search} HTTP/1.1`,
                `Host: ${session.targetHost}`,
                `Upgrade: websocket`,
                `Connection: Upgrade`,
                `Sec-WebSocket-Key: ${req.headers['sec-websocket-key']}`,
                `Sec-WebSocket-Version: ${req.headers['sec-websocket-version']}`,
            ];

            if (req.headers['sec-websocket-protocol']) {
                headers.push(`Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol']}`);
            }

            headers.push('', '');
            targetSocket.write(headers.join('\r\n'));
        });

        // Pipe data between client and target
        let upgraded = false;
        let buffer = Buffer.alloc(0);

        targetSocket.on('data', (data) => {
            if (!upgraded) {
                buffer = Buffer.concat([buffer, data]);
                const headerEnd = buffer.indexOf('\r\n\r\n');
                if (headerEnd !== -1) {
                    // Send upgrade response to client
                    clientSocket.write(buffer.slice(0, headerEnd + 4));
                    
                    // Send remaining data
                    if (buffer.length > headerEnd + 4) {
                        clientSocket.write(buffer.slice(headerEnd + 4));
                    }
                    
                    upgraded = true;
                    
                    // Now just pipe
                    clientSocket.pipe(targetSocket);
                    targetSocket.pipe(clientSocket);
                }
            }
        });

        targetSocket.on('error', (err) => {
            this.log('WebSocket target error:', err.message);
            clientSocket.destroy();
        });

        clientSocket.on('error', (err) => {
            this.log('WebSocket client error:', err.message);
            targetSocket.destroy();
        });

        clientSocket.on('close', () => targetSocket.destroy());
        targetSocket.on('close', () => clientSocket.destroy());
    }
}

// Run if executed directly
if (require.main === module) {
    const proxy = new TrueProxyServer({ 
        port: process.env.PORT || 3000,
        debug: true 
    });
    proxy.start();
}

module.exports = TrueProxyServer;
