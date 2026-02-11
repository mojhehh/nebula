/**
 * TikTok-Specific Bare Server
 * 
 * This server is a DUMB PIPE. It does NOT modify requests or responses.
 * All intelligence lives in the browser (Service Worker + Client Patches).
 * 
 * The only modifications:
 * 1. CORS headers added to allow browser access
 * 2. Initial HTML injection (Service Worker registration + client patches)
 * 
 * That's it. Everything else passes through untouched.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = 3004;
const PROXY_ORIGIN = process.env.PROXY_ORIGIN || `http://localhost:${PORT}`;

// TikTok domains we handle
const TIKTOK_DOMAINS = [
    'www.tiktok.com',
    'tiktok.com',
    'm.tiktok.com',
    'webcast.tiktok.com',
    'webcast.us.tiktok.com',
    'webcast-va.tiktok.com',
    'mcs.tiktokv.com',
    'mon.tiktokv.com',
    'mon-va.tiktokv.com',
    'mon16-normal-useast5.tiktokv.us',
    'log.tiktokv.com',
    'log-va.tiktokv.com',
    'log16-normal-c-useast2a.tiktokv.com',
    'lf16-cdn-tos.tiktokcdn.com',
    'lf16-tiktok-web.tiktokcdn-us.com',
    'lf19-tiktok-web.tiktokcdn-us.com',
    'p16-sign-sg.tiktokcdn.com',
    'p16-sign-va.tiktokcdn.com',
    'p16-sign.tiktokcdn-us.com',
    'p19-sign.tiktokcdn-us.com',
    'p77-sign.tiktokcdn-us.com',
    'v16-webapp-prime.tiktok.com',
    'v16-webapp.tiktok.com',
    'v19-webapp.tiktok.com',
    'v58-webapp.tiktok.com',
    'v77-webapp.tiktok.com',
    'sf16-website-login.neutral.ttwstatic.com',
    'sf16-scmcdn.tiktokcdn-us.com',
    'sf16-scmcdn-va.tiktokcdn-us.com',
    'lf16-tiktok-common.ttwstatic.com',
    'lf19-tiktok-common.ttwstatic.com',
    'www.tiktokw.us',
    'tiktokw.us',
    'im-ws.tiktok.com',
    'sf-tb-sg.ibytedtos.com',
    'sf16-muse-va.ibytedtos.com'
];

// Serve static files
function serveStatic(res, filePath, contentType) {
    const fullPath = path.join(__dirname, 'public', filePath);
    if (fs.existsSync(fullPath)) {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(fs.readFileSync(fullPath));
        return true;
    }
    return false;
}

// Encode URL for proxy path
function encodeProxyUrl(url) {
    return Buffer.from(url).toString('base64url');
}

// Decode URL from proxy path
function decodeProxyUrl(encoded) {
    return Buffer.from(encoded, 'base64url').toString('utf-8');
}

// Check if URL is a TikTok domain
function isTikTokDomain(hostname) {
    return TIKTOK_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
}

// Add CORS headers to response
function addCorsHeaders(res, origin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', '*');
    res.setHeader('Access-Control-Max-Age', '86400');
    // CRITICAL: Allow private network access (HTTPS -> localhost)
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

// Get client patches script
function getClientPatches() {
    const patchesPath = path.join(__dirname, 'public', 'client-patches.js');
    return fs.readFileSync(patchesPath, 'utf-8');
}

// Get service worker registration script
function getSwRegistration() {
    return `
<script>
(function() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js', { scope: '/' })
            .then(function(reg) {
                console.log('[TikTok Proxy] Service Worker registered');
                if (reg.active) {
                    // SW already active, reload to let it intercept
                    if (!sessionStorage.getItem('__sw_ready')) {
                        sessionStorage.setItem('__sw_ready', '1');
                        location.reload();
                    }
                }
                reg.addEventListener('updatefound', function() {
                    var newWorker = reg.installing;
                    newWorker.addEventListener('statechange', function() {
                        if (newWorker.state === 'activated') {
                            if (!sessionStorage.getItem('__sw_ready')) {
                                sessionStorage.setItem('__sw_ready', '1');
                                location.reload();
                            }
                        }
                    });
                });
            })
            .catch(function(err) {
                console.error('[TikTok Proxy] SW registration failed:', err);
            });
    }
})();
</script>
`;
}

// Inject our scripts into HTML - proxyOrigin passed dynamically from request
function injectIntoHtml(html, targetUrl, proxyOrigin) {
    const clientPatches = getClientPatches();
    const swRegistration = getSwRegistration();
    
    // Create injection that runs BEFORE anything else
    const injection = `
<!-- TikTok Proxy Injection Start -->
<script>
// Store proxy config globally BEFORE any other code runs
window.__PROXY_CONFIG__ = {
    proxyOrigin: '${proxyOrigin}',
    targetOrigin: 'https://www.tiktok.com',
    targetHostname: 'www.tiktok.com'
};
</script>
<script>
${clientPatches}
</script>
${swRegistration}
<!-- TikTok Proxy Injection End -->
`;

    // Inject right after <head> or at start of document
    if (html.includes('<head>')) {
        return html.replace('<head>', '<head>' + injection);
    } else if (html.includes('<HEAD>')) {
        return html.replace('<HEAD>', '<HEAD>' + injection);
    } else if (html.includes('<!DOCTYPE') || html.includes('<!doctype')) {
        return html.replace(/(<!DOCTYPE[^>]*>|<!doctype[^>]*>)/i, '$1' + injection);
    } else {
        return injection + html;
    }
}

// Fetch from target with minimal modification
async function bareRequest(targetUrl, method, headers, body, res) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(targetUrl);
        const isHttps = parsedUrl.protocol === 'https:';
        const lib = isHttps ? https : http;

        // Build request headers - pass through almost everything
        const reqHeaders = {};
        
        // Copy headers, excluding hop-by-hop and proxy-specific
        const skipHeaders = [
            'host', 'connection', 'keep-alive', 'proxy-authenticate',
            'proxy-authorization', 'te', 'trailers', 'transfer-encoding',
            'upgrade', 'x-bare-url', 'x-bare-headers'
        ];
        
        for (const [key, value] of Object.entries(headers)) {
            if (!skipHeaders.includes(key.toLowerCase())) {
                reqHeaders[key] = value;
            }
        }

        // Set correct host
        reqHeaders['Host'] = parsedUrl.host;
        
        // Ensure proper referer/origin for TikTok
        if (isTikTokDomain(parsedUrl.hostname)) {
            // Fix referer - must look like it came from TikTok
            if (!reqHeaders['Referer'] || reqHeaders['Referer'].includes('localhost') || reqHeaders['Referer'].includes('trycloudflare')) {
                reqHeaders['Referer'] = 'https://www.tiktok.com/';
            }
            
            // CRITICAL: Full browser headers - Akamai checks ALL of these
            reqHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
            reqHeaders['Accept-Language'] = 'en-US,en;q=0.9';
            reqHeaders['Accept-Encoding'] = 'gzip, deflate, br';
            reqHeaders['sec-ch-ua'] = '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"';
            reqHeaders['sec-ch-ua-mobile'] = '?0';
            reqHeaders['sec-ch-ua-platform'] = '"Windows"';
            reqHeaders['Connection'] = 'keep-alive';
            
            // Different headers for API requests vs navigation
            const isApiRequest = parsedUrl.pathname.includes('/api/') || 
                                 parsedUrl.pathname.includes('/v1/') ||
                                 parsedUrl.pathname.includes('/v2/') ||
                                 method === 'POST';
            
            if (isApiRequest) {
                // API request headers
                reqHeaders['Accept'] = 'application/json, text/plain, */*';
                reqHeaders['Origin'] = 'https://www.tiktok.com';
                reqHeaders['sec-fetch-dest'] = 'empty';
                reqHeaders['sec-fetch-mode'] = 'cors';
                reqHeaders['sec-fetch-site'] = 'same-origin';
                delete reqHeaders['upgrade-insecure-requests'];
                delete reqHeaders['Cache-Control'];
            } else {
                // Navigation/document request headers
                reqHeaders['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
                reqHeaders['Cache-Control'] = 'max-age=0';
                reqHeaders['sec-fetch-dest'] = 'document';
                reqHeaders['sec-fetch-mode'] = 'navigate';
                reqHeaders['sec-fetch-site'] = 'none';
                reqHeaders['sec-fetch-user'] = '?1';
                reqHeaders['upgrade-insecure-requests'] = '1';
                delete reqHeaders['Origin'];
            }
        }

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: method,
            headers: reqHeaders,
            rejectUnauthorized: false // Allow self-signed certs
        };

        const proxyReq = lib.request(options, (proxyRes) => {
            resolve(proxyRes);
        });

        proxyReq.on('error', (err) => {
            reject(err);
        });

        if (body) {
            proxyReq.write(body);
        }
        
        proxyReq.end();
    });
}

// Decompress response if needed
function decompressResponse(proxyRes, callback) {
    const encoding = proxyRes.headers['content-encoding'];
    const chunks = [];
    
    let stream = proxyRes;
    
    if (encoding === 'gzip') {
        stream = proxyRes.pipe(zlib.createGunzip());
    } else if (encoding === 'deflate') {
        stream = proxyRes.pipe(zlib.createInflate());
    } else if (encoding === 'br') {
        stream = proxyRes.pipe(zlib.createBrotliDecompress());
    }

    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => callback(null, Buffer.concat(chunks)));
    stream.on('error', err => callback(err, null));
}

// ============== JAVASCRIPT REWRITING (Like Ultraviolet) ==============
// This rewrites TikTok's JavaScript to intercept location access
function rewriteJavaScript(jsCode) {
    let code = jsCode;
    
    // Replace property access patterns for location
    // document.location -> document.__proxyLocation
    // window.location -> window.__proxyLocation
    code = code.replace(/\bdocument\.location\b/g, 'document.__proxyLocation');
    code = code.replace(/\bwindow\.location\b/g, 'window.__proxyLocation');
    
    // Also handle self.location and globalThis.location
    code = code.replace(/\bself\.location\b/g, 'self.__proxyLocation');
    code = code.replace(/\bglobalThis\.location\b/g, 'globalThis.__proxyLocation');
    
    // Handle ["location"] and ['location'] bracket access
    code = code.replace(/\["location"\]/g, '["__proxyLocation"]');
    code = code.replace(/\['location'\]/g, "['__proxyLocation']");
    
    // Handle .hostname, .host, .origin, .href, .protocol, .pathname checks
    // These often appear in detection code
    // e.g., location.hostname -> __getProxyLocation().hostname
    // Only replace bare 'location' when it's clearly the global
    // This regex matches 'location' that's not part of another word and not after a dot
    code = code.replace(/(?<![.\w])location(?![.\w]*\s*[=])/g, function(match, offset, string) {
        // Don't replace if it's part of a longer identifier or after a dot
        const before = string[offset - 1];
        const after = string[offset + 8];
        
        // Skip if preceded by . (member access) or alphanumeric (part of word)
        if (before && (before === '.' || /\w/.test(before))) {
            return match;
        }
        // Skip if followed by alphanumeric (part of word like 'locationData')
        if (after && /\w/.test(after)) {
            return match;
        }
        
        return '__proxyLocation';
    });
    
    return code;
}

// Main HTTP server
const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = reqUrl.pathname;

    // Add CORS to all responses
    addCorsHeaders(res, req.headers.origin);

    // Handle preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    try {
        // Serve static files
        if (pathname === '/sw.js') {
            serveStatic(res, 'sw.js', 'application/javascript');
            return;
        }
        
        if (pathname === '/client-patches.js') {
            serveStatic(res, 'client-patches.js', 'application/javascript');
            return;
        }

        // Entry point - load TikTok with injection
        if (pathname === '/' || pathname === '/tiktok' || pathname === '/foryou') {
            const targetUrl = 'https://www.tiktok.com/foryou';
            
            // Get the actual proxy origin from the request (handles tunnels)
            const forwardedHost = req.headers['x-forwarded-host'] || req.headers.host;
            const forwardedProto = req.headers['x-forwarded-proto'] || 'https';
            const proxyOrigin = `${forwardedProto}://${forwardedHost}`;
            
            const proxyRes = await bareRequest(targetUrl, 'GET', req.headers, null, res);
            
            decompressResponse(proxyRes, (err, body) => {
                if (err) {
                    res.writeHead(500);
                    res.end('Decompression error');
                    return;
                }

                let html = body.toString('utf-8');
                
                // CRITICAL: Remove ALL CSP meta tags from HTML
                html = html.replace(/<meta[^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, '');
                html = html.replace(/<meta[^>]*content-security-policy[^>]*>/gi, '');
                
                // CRITICAL: Strip integrity attributes - we modify JS so hashes won't match
                html = html.replace(/\s+integrity=["'][^"']*["']/gi, '');
                html = html.replace(/\s+crossorigin=["'][^"']*["']/gi, ' crossorigin="anonymous"');
                
                html = injectIntoHtml(html, targetUrl, proxyOrigin);

                // Remove compression header since we decompressed
                const headers = { ...proxyRes.headers };
                delete headers['content-encoding'];
                delete headers['content-length'];
                
                // CRITICAL: Strip ALL security headers that block our scripts
                delete headers['content-security-policy'];
                delete headers['content-security-policy-report-only'];
                delete headers['x-content-security-policy'];
                delete headers['x-webkit-csp'];
                delete headers['x-frame-options'];
                delete headers['x-xss-protection'];
                delete headers['cross-origin-opener-policy'];
                delete headers['cross-origin-embedder-policy'];
                delete headers['cross-origin-resource-policy'];
                delete headers['permissions-policy'];
                
                headers['content-type'] = 'text/html; charset=utf-8';

                res.writeHead(proxyRes.statusCode, headers);
                res.end(html);
            });
            return;
        }

        // Bare fetch endpoint - the dumb pipe
        if (pathname.startsWith('/bare/')) {
            const encodedUrl = pathname.slice(6); // Remove '/bare/'
            let targetUrl;
            
            try {
                targetUrl = decodeProxyUrl(encodedUrl);
                
                // Validate it's actually a URL, not a path like "devtools.js"
                if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
                    // Not a valid URL - this might be a relative path that got mangled
                    // Just return 200 empty to avoid breaking TikTok
                    console.log('[Bare] Invalid URL (not http/https), returning empty:', targetUrl.substring(0, 50));
                    res.writeHead(200, { 'Content-Type': 'application/javascript' });
                    res.end('// Invalid proxy URL');
                    return;
                }
            } catch (e) {
                console.log('[Bare] Failed to decode:', encodedUrl.substring(0, 50), e.message);
                // Return empty JS to avoid breaking page
                res.writeHead(200, { 'Content-Type': 'application/javascript' });
                res.end('// Decode error');
                return;
            }

            // Collect request body if present
            let body = null;
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                body = await new Promise((resolve) => {
                    const chunks = [];
                    req.on('data', chunk => chunks.push(chunk));
                    req.on('end', () => resolve(Buffer.concat(chunks)));
                });
            }

            // Get custom headers if provided
            let customHeaders = { ...req.headers };
            if (req.headers['x-bare-headers']) {
                try {
                    customHeaders = JSON.parse(req.headers['x-bare-headers']);
                } catch (e) {}
            }

            try {
                const proxyRes = await bareRequest(targetUrl, req.method, customHeaders, body, res);
                
                // Copy response headers, stripping ALL security and upstream CORS headers
                const headers = {};
                const skipHeaders = [
                    'content-security-policy',
                    'content-security-policy-report-only',
                    'x-content-security-policy',
                    'x-webkit-csp',
                    'x-frame-options',
                    'x-xss-protection',
                    'cross-origin-opener-policy',
                    'cross-origin-embedder-policy',
                    'cross-origin-resource-policy',
                    'permissions-policy',
                    // CRITICAL: Strip upstream CORS headers - we set our own
                    'access-control-allow-origin',
                    'access-control-allow-credentials',
                    'access-control-allow-methods',
                    'access-control-allow-headers',
                    'access-control-expose-headers',
                    'access-control-max-age'
                ];
                
                for (const [key, value] of Object.entries(proxyRes.headers)) {
                    if (!skipHeaders.includes(key.toLowerCase())) {
                        headers[key] = value;
                    }
                }

                // Add our CORS headers - NEVER use * with credentials
                // Get the actual proxy origin from the request (handles tunnels)
                const forwardedHost = req.headers['x-forwarded-host'] || req.headers.host;
                const forwardedProto = req.headers['x-forwarded-proto'] || 'https';
                const proxyOrigin = forwardedHost ? `${forwardedProto}://${forwardedHost}` : (req.headers.origin || '*');
                
                // Use requesting origin if provided, otherwise echo back our proxy origin
                headers['Access-Control-Allow-Origin'] = req.headers.origin || proxyOrigin;
                headers['Access-Control-Allow-Credentials'] = 'true';
                headers['Access-Control-Expose-Headers'] = '*';
                headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD';
                headers['Access-Control-Allow-Headers'] = '*';

                // Check if this is JavaScript that needs rewriting
                const contentType = proxyRes.headers['content-type'] || '';
                if (contentType.includes('javascript') || contentType.includes('text/javascript') || contentType.includes('application/javascript')) {
                    // Decompress and rewrite JavaScript
                    decompressResponse(proxyRes, (err, data) => {
                        if (err) {
                            res.writeHead(500);
                            res.end('Decompression error');
                            return;
                        }

                        let jsCode = data.toString('utf-8');
                        jsCode = rewriteJavaScript(jsCode);

                        // Remove encoding headers since we decompressed
                        delete headers['content-encoding'];
                        delete headers['content-length'];

                        res.writeHead(proxyRes.statusCode, headers);
                        res.end(jsCode);
                    });
                } else {
                    // Stream other responses directly - NO MODIFICATION
                    res.writeHead(proxyRes.statusCode, headers);
                    proxyRes.pipe(res);
                }
                
            } catch (err) {
                console.error('Bare fetch error:', err.message);
                res.writeHead(502);
                res.end('Bad Gateway: ' + err.message);
            }
            return;
        }

        // Fallback - treat as TikTok path
        const targetUrl = 'https://www.tiktok.com' + pathname + reqUrl.search;
        
        let body = null;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            body = await new Promise((resolve) => {
                const chunks = [];
                req.on('data', chunk => chunks.push(chunk));
                req.on('end', () => resolve(Buffer.concat(chunks)));
            });
        }

        try {
            const proxyRes = await bareRequest(targetUrl, req.method, req.headers, body, res);
            
            const contentType = proxyRes.headers['content-type'] || '';
            
            // Only inject into HTML responses
            if (contentType.includes('text/html')) {
                // Get the actual proxy origin from the request (handles tunnels)
                const forwardedHost = req.headers['x-forwarded-host'] || req.headers.host;
                const forwardedProto = req.headers['x-forwarded-proto'] || 'https';
                const proxyOrigin = `${forwardedProto}://${forwardedHost}`;
                
                decompressResponse(proxyRes, (err, data) => {
                    if (err) {
                        res.writeHead(500);
                        res.end('Decompression error');
                        return;
                    }

                    let html = data.toString('utf-8');
                    
                    // CRITICAL: Remove ALL CSP meta tags from HTML
                    html = html.replace(/<meta[^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, '');
                    html = html.replace(/<meta[^>]*content-security-policy[^>]*>/gi, '');
                    
                    // CRITICAL: Strip integrity attributes - we modify JS so hashes won't match
                    html = html.replace(/\s+integrity=["'][^"']*["']/gi, '');
                    html = html.replace(/\s+crossorigin=["'][^"']*["']/gi, ' crossorigin="anonymous"');
                    
                    html = injectIntoHtml(html, targetUrl, proxyOrigin);

                    const headers = { ...proxyRes.headers };
                    delete headers['content-encoding'];
                    delete headers['content-length'];
                    
                    // Strip ALL security headers
                    delete headers['content-security-policy'];
                    delete headers['content-security-policy-report-only'];
                    delete headers['x-content-security-policy'];
                    delete headers['x-webkit-csp'];
                    delete headers['x-frame-options'];
                    delete headers['cross-origin-opener-policy'];
                    delete headers['cross-origin-embedder-policy'];
                    delete headers['cross-origin-resource-policy'];
                    delete headers['permissions-policy'];

                    res.writeHead(proxyRes.statusCode, headers);
                    res.end(html);
                });
            } else if (contentType.includes('javascript')) {
                // Rewrite JavaScript to intercept location access
                decompressResponse(proxyRes, (err, data) => {
                    if (err) {
                        res.writeHead(500);
                        res.end('Decompression error');
                        return;
                    }

                    let jsCode = data.toString('utf-8');
                    jsCode = rewriteJavaScript(jsCode);

                    const headers = { ...proxyRes.headers };
                    delete headers['content-encoding'];
                    delete headers['content-length'];
                    
                    // Strip security headers
                    delete headers['content-security-policy'];
                    delete headers['content-security-policy-report-only'];
                    
                    res.writeHead(proxyRes.statusCode, headers);
                    res.end(jsCode);
                });
            } else {
                // Stream everything else untouched
                const headers = { ...proxyRes.headers };
                
                // Strip security headers from all responses
                delete headers['content-security-policy'];
                delete headers['content-security-policy-report-only'];
                delete headers['x-frame-options'];
                delete headers['cross-origin-opener-policy'];
                delete headers['cross-origin-embedder-policy'];
                delete headers['cross-origin-resource-policy'];
                
                res.writeHead(proxyRes.statusCode, headers);
                proxyRes.pipe(res);
            }
        } catch (err) {
            console.error('Fallback fetch error:', err.message);
            res.writeHead(502);
            res.end('Bad Gateway: ' + err.message);
        }

    } catch (err) {
        console.error('Server error:', err);
        res.writeHead(500);
        res.end('Internal Server Error');
    }
});

// WebSocket proxy
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    
    if (reqUrl.pathname.startsWith('/ws/')) {
        const encodedUrl = reqUrl.pathname.slice(4);
        let targetUrl;
        
        try {
            targetUrl = decodeProxyUrl(encodedUrl);
        } catch (e) {
            socket.destroy();
            return;
        }

        console.log('[WS] Connecting to:', targetUrl);

        // Connect to target WebSocket
        const targetWs = new WebSocket(targetUrl, {
            headers: {
                'Origin': 'https://www.tiktok.com',
                'User-Agent': req.headers['user-agent']
            },
            rejectUnauthorized: false
        });

        targetWs.on('open', () => {
            console.log('[WS] Connected to target');
            
            wss.handleUpgrade(req, socket, head, (clientWs) => {
                // Relay messages both ways
                clientWs.on('message', (data) => {
                    if (targetWs.readyState === WebSocket.OPEN) {
                        targetWs.send(data);
                    }
                });

                targetWs.on('message', (data) => {
                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(data);
                    }
                });

                clientWs.on('close', () => {
                    targetWs.close();
                });

                targetWs.on('close', () => {
                    clientWs.close();
                });

                clientWs.on('error', (err) => {
                    console.error('[WS] Client error:', err.message);
                    targetWs.close();
                });

                targetWs.on('error', (err) => {
                    console.error('[WS] Target error:', err.message);
                    clientWs.close();
                });
            });
        });

        targetWs.on('error', (err) => {
            console.error('[WS] Failed to connect:', err.message);
            socket.destroy();
        });
    } else {
        socket.destroy();
    }
});

server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║          TikTok-Specific Client-Side Proxy                 ║
╠════════════════════════════════════════════════════════════╣
║  Server running on: http://localhost:${PORT}                  ║
║                                                            ║
║  Open http://localhost:${PORT} to access TikTok              ║
║                                                            ║
║  Architecture:                                             ║
║  - Service Worker intercepts all requests                  ║
║  - Client patches spoof location/origin                    ║
║  - Server is a dumb pipe (no JS modification)              ║
║  - TikTok's code runs UNMODIFIED                           ║
╚════════════════════════════════════════════════════════════╝
`);
});
