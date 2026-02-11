/**
 * TikTok Proxy Service Worker
 * 
 * This is the CORE of the client-side proxy. It intercepts ALL network requests
 * and rewrites them to go through our bare server.
 * 
 * CRITICAL: We do NOT modify response bodies. TikTok's JS runs unmodified.
 * We only change WHERE requests go, not WHAT they contain.
 */

// CRITICAL: Get the origin dynamically - handles both localhost and tunnel
const PROXY_ORIGIN = self.location.origin;
const TIKTOK_ORIGIN = 'https://www.tiktok.com';

// Log the origin for debugging
console.log('[SW] Service Worker loaded');
console.log('[SW] PROXY_ORIGIN:', PROXY_ORIGIN);
console.log('[SW] self.location.href:', self.location.href);

// All TikTok-related domains - use partial matching
const TIKTOK_DOMAIN_PATTERNS = [
    'tiktok.com',
    'tiktok.us',
    'tiktokv.com',
    'tiktokv.us',
    'tiktokcdn.com',
    'tiktokcdn-us.com',
    'tiktokcdn-eu.com',
    'ttwstatic.com',
    'ibytedtos.com',
    'bytedtos.com',
    'byteimg.com',
    'bytednsdomain.com',
    'tiktokw.us',
    'musical.ly',
    'muscdn.com',
    'isnssdk.com',
    'byteoversea.com'
];

// URLs we should NEVER intercept
const BYPASS_PATTERNS = [
    /^chrome-extension:/,
    /^moz-extension:/,
    /^safari-extension:/,
    /^about:/,
    /^blob:/,
    /^data:/,
    /^javascript:/,
    // Don't intercept our own proxy resources
    /\/sw\.js$/,
    /\/client-patches\.js$/
];

// Check if URL should bypass the proxy
function shouldBypass(url) {
    const urlStr = url.toString();
    return BYPASS_PATTERNS.some(pattern => pattern.test(urlStr));
}

// Check if URL is a video/media CDN that should go DIRECT (not through proxy)
// These get 403'd by Akamai when coming from datacenter IPs
function isVideoCdn(url) {
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.toLowerCase();
        const pathname = urlObj.pathname.toLowerCase();
        
        // Video CDN domains - let these go direct to avoid 403
        const videoCdnPatterns = [
            'v16-webapp', 'v19-webapp', 'v58-webapp', 'v77-webapp',
            'webapp-prime', 'pull-', 'pull16-', 'pull19-'
        ];
        
        // Check if it's a video CDN hostname
        if (videoCdnPatterns.some(p => hostname.includes(p))) {
            return true;
        }
        
        // Check for video file extensions
        if (pathname.includes('/video/') || 
            pathname.endsWith('.mp4') || 
            pathname.endsWith('.webm') ||
            pathname.includes('mime_type=video')) {
            return true;
        }
        
        // Check URL params for video indicators
        if (urlObj.search.includes('mime_type=video') ||
            urlObj.search.includes('ply_type=')) {
            return true;
        }
        
        return false;
    } catch {
        return false;
    }
}

// Check if URL is a TikTok domain (uses partial pattern matching)
function isTikTokUrl(url) {
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        return TIKTOK_DOMAIN_PATTERNS.some(pattern => hostname.includes(pattern));
    } catch {
        return false;
    }
}

// Encode URL for bare endpoint
function encodeUrl(url) {
    return btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Rewrite URL to go through proxy
function rewriteUrl(originalUrl) {
    const url = new URL(originalUrl);
    
    // Already going through our proxy
    if (url.origin === PROXY_ORIGIN) {
        return originalUrl;
    }
    
    // Bypass non-TikTok domains (let them go directly)
    if (!isTikTokUrl(originalUrl)) {
        return originalUrl; // Let non-TikTok requests go directly
    }
    
    // ALL TikTok requests (including video CDN) go through proxy
    // This is required for CORS to work through the tunnel
    console.log('[SW] Proxying:', url.hostname, url.pathname.substring(0, 50));
    return `${PROXY_ORIGIN}/bare/${encodeUrl(originalUrl)}`;
}

// Clone headers for passing to bare endpoint
function cloneHeaders(headers) {
    const result = {};
    for (const [key, value] of headers.entries()) {
        result[key] = value;
    }
    return result;
}

// Install event - activate immediately
self.addEventListener('install', (event) => {
    console.log('[SW] Installing TikTok Proxy Service Worker');
    self.skipWaiting();
});

// Activate event - claim all clients immediately
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating TikTok Proxy Service Worker');
    event.waitUntil(self.clients.claim());
});

// Fetch event - the main interception point
self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = request.url;

    // Check bypass conditions
    if (shouldBypass(url)) {
        return; // Let browser handle it
    }

    // Handle navigation requests (page loads)
    if (request.mode === 'navigate') {
        event.respondWith(handleNavigation(request));
        return;
    }

    // Handle all other requests
    event.respondWith(handleFetch(request));
});

// Handle navigation (page load) requests
async function handleNavigation(request) {
    const url = new URL(request.url);
    
    console.log('[SW] Navigation:', url.pathname);

    // If navigating to our proxy origin, pass through
    if (url.origin === PROXY_ORIGIN) {
        // Let the server handle it - it will inject scripts
        return fetch(request);
    }

    // If trying to navigate to TikTok directly, redirect to proxy
    if (isTikTokUrl(request.url)) {
        const proxyUrl = PROXY_ORIGIN + url.pathname + url.search;
        return Response.redirect(proxyUrl, 302);
    }

    // Non-TikTok navigation - pass through
    return fetch(request);
}

// Handle fetch requests (API calls, resources, etc.)
async function handleFetch(request) {
    const originalUrl = request.url;
    
    // Skip undefined or invalid URLs
    if (!originalUrl || originalUrl === 'undefined' || originalUrl.endsWith('/undefined')) {
        return new Response('Invalid URL', { status: 400 });
    }
    
    // Check if this needs proxying
    if (!isTikTokUrl(originalUrl) && !originalUrl.startsWith(PROXY_ORIGIN)) {
        // Non-TikTok, non-proxy URL - let it go directly
        return fetch(request);
    }

    // If it's already a proxy URL, extract the real target
    let targetUrl = originalUrl;
    if (originalUrl.startsWith(PROXY_ORIGIN + '/bare/')) {
        // Already rewritten, pass through
        return fetch(request);
    }

    // Rewrite TikTok URLs to go through bare proxy
    if (isTikTokUrl(originalUrl)) {
        targetUrl = rewriteUrl(originalUrl);
    }

    // Clone headers but fix origin/referer
    const headers = cloneHeaders(request.headers);
    
    // Set proper TikTok headers
    headers['Origin'] = TIKTOK_ORIGIN;
    headers['Referer'] = TIKTOK_ORIGIN + '/';
    
    // Remove service worker identifier
    delete headers['service-worker'];

    try {
        // Build the proxied request
        const proxyRequest = new Request(targetUrl, {
            method: request.method,
            headers: headers,
            body: request.method !== 'GET' && request.method !== 'HEAD' ? await request.clone().arrayBuffer() : null,
            mode: 'cors',
            credentials: 'include',
            redirect: 'follow'
        });

        const response = await fetch(proxyRequest);

        // Handle null-body status codes (204, 304, etc.) - cannot have body
        const nullBodyStatuses = [101, 204, 205, 304];
        if (nullBodyStatuses.includes(response.status)) {
            return new Response(null, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
            });
        }

        // Clone response with modified headers
        const responseHeaders = new Headers(response.headers);
        
        // Ensure CORS is allowed
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Access-Control-Allow-Credentials', 'true');
        
        // Remove restrictive headers
        responseHeaders.delete('Content-Security-Policy');
        responseHeaders.delete('Content-Security-Policy-Report-Only');
        responseHeaders.delete('X-Frame-Options');

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders
        });

    } catch (err) {
        console.error('[SW] Fetch error for', originalUrl, ':', err.message);
        
        // Return error response
        return new Response(JSON.stringify({ error: err.message }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

// Handle messages from the main page
self.addEventListener('message', (event) => {
    if (event.data === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    
    if (event.data === 'CLAIM_CLIENTS') {
        self.clients.claim();
    }
});

console.log('[SW] TikTok Proxy Service Worker loaded');
