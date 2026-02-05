/**
 * SERVER-SIDE URL REWRITING PROXY
 * ================================
 * Works EXACTLY like CroxyProxy!
 * 
 * KEY DIFFERENCE:
 * - Ultraviolet: Client-side Service Worker does rewriting (breaks often)
 * - This proxy: Server fetches page, rewrites ALL URLs, serves native HTML
 * 
 * WHY THIS IS FASTER:
 * - No video encoding/streaming
 * - Client renders native HTML (iPad handles this great!)
 * - Works through Cloudflare tunnel
 * - No WebSocket connection needed for viewing
 * 
 * URL FORMAT: /real/path?__cpo=BASE64_ENCODED_URL (like CroxyProxy!)
 * Example: /explore?__cpo=aHR0cHM6Ly93d3cudGlrdG9rLmNvbQ
 * 
 * WHY THIS FORMAT WORKS:
 * - React Router sees the REAL path (/explore) not /browse/xxx
 * - SPA routing works correctly
 * - No 404 redirects from client-side routers
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');

const PORT = process.env.PORT || 3003;

// Session management
const sessions = new Map();

/**
 * Encode URL to base64 (like CroxyProxy's __cpo parameter)
 * Uses URL-safe base64 to avoid issues with / and + in URLs
 */
function encodeUrl(url) {
    return Buffer.from(url).toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

/**
 * Decode base64 URL - handles URL-safe base64 and query strings
 */
function decodeUrl(encoded) {
    try {
        // The encoded part might have query string after it - split it off
        let base64Part = encoded.split('?')[0].split('&')[0];
        
        // Handle URL-safe base64 (- and _ instead of + and /)
        let base64 = base64Part.replace(/-/g, '+').replace(/_/g, '/');
        
        // Add padding if needed
        while (base64.length % 4) base64 += '=';
        
        // URL decode first in case it was double-encoded
        try {
            base64 = decodeURIComponent(base64);
        } catch(e) {}
        
        const decoded = Buffer.from(base64, 'base64').toString('utf-8');
        
        // CRITICAL: Validate that the result is actually a valid URL!
        // Invalid base64 (like "core.js") decodes to garbage, not a URL
        if (!decoded.startsWith('http://') && !decoded.startsWith('https://')) {
            console.log(`[DECODE] Not a valid URL: ${decoded.substring(0, 30)}... (from ${encoded.substring(0, 30)})`);
            return null;
        }
        
        // Additional validation - try to parse as URL
        try {
            new URL(decoded);
        } catch (e) {
            console.log(`[DECODE] Invalid URL format: ${decoded.substring(0, 50)}`);
            return null;
        }
        
        return decoded;
    } catch (e) {
        console.error('[DECODE ERROR]', e.message, 'for:', encoded.substring(0, 50));
        return null;
    }
}

// Store the current base URL for each session (by referer)
const sessionBaseUrls = new Map();

// Store CSRF tokens per domain
const csrfTokens = new Map();

/**
 * Make HTTP/HTTPS request with full handling
 */
function fetchUrl(url, options = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? https : http;
        const domain = parsed.hostname;
        
        const reqOptions = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: options.method || 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': options.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                ...(options.headers || {})
            },
            rejectUnauthorized: false,
            timeout: 30000
        };
        
        // Set proper Origin and Referer for the target domain
        reqOptions.headers['Origin'] = parsed.origin;
        reqOptions.headers['Referer'] = options.referer || parsed.origin + '/';
        
        // Add CSRF token for Roblox and similar sites (from stored tokens or incoming request)
        if (options.csrfToken) {
            reqOptions.headers['x-csrf-token'] = options.csrfToken;
        } else if (csrfTokens.has(domain)) {
            reqOptions.headers['x-csrf-token'] = csrfTokens.get(domain);
        }
        
        // Add content-length for POST bodies
        if (options.body) {
            reqOptions.headers['Content-Length'] = Buffer.byteLength(options.body);
        }
        
        // Add cookies if we have them
        if (options.cookies) {
            reqOptions.headers['Cookie'] = options.cookies;
        }

        const req = lib.request(reqOptions, (res) => {
            // Handle redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const redirectUrl = new URL(res.headers.location, url).href;
                console.log(`[REDIRECT] ${res.statusCode} -> ${redirectUrl}`);
                resolve(fetchUrl(redirectUrl, options));
                return;
            }
            
            // Store CSRF token from response for future requests
            if (res.headers['x-csrf-token']) {
                csrfTokens.set(domain, res.headers['x-csrf-token']);
                console.log(`[CSRF] Stored token for ${domain}: ${res.headers['x-csrf-token'].substring(0, 20)}...`);
            }
            
            const chunks = [];
            
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const encoding = res.headers['content-encoding'];
                
                const finish = (data) => {
                    resolve({
                        data,
                        headers: res.headers,
                        statusCode: res.statusCode,
                        url: url
                    });
                };
                
                // Decompress if needed
                try {
                    if (encoding === 'gzip') {
                        zlib.gunzip(buffer, (err, decoded) => {
                            if (err) {
                                console.warn(`[GUNZIP WARN] ${err.message}, using raw buffer`);
                            }
                            finish(err ? buffer : decoded);
                        });
                    } else if (encoding === 'deflate') {
                        zlib.inflate(buffer, (err, decoded) => {
                            if (err) {
                                // Try inflateRaw as fallback
                                zlib.inflateRaw(buffer, (err2, decoded2) => {
                                    if (err2) {
                                        console.warn(`[INFLATE WARN] ${err2.message}, using raw buffer`);
                                    }
                                    finish(err2 ? buffer : decoded2);
                                });
                            } else {
                                finish(decoded);
                            }
                        });
                    } else if (encoding === 'br') {
                        zlib.brotliDecompress(buffer, (err, decoded) => {
                            if (err) {
                                console.warn(`[BROTLI WARN] ${err.message}, using raw buffer`);
                            }
                            finish(err ? buffer : decoded);
                        });
                    } else {
                        finish(buffer);
                    }
                } catch (decompressError) {
                    console.warn(`[DECOMPRESS WARN] ${decompressError.message}`);
                    finish(buffer);
                }
            });
        });

        req.on('error', (e) => {
            console.error(`[FETCH ERROR] ${url}: ${e.message}`);
            reject(e);
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout for: ' + url.substring(0, 100)));
        });
        
        if (options.body) {
            req.write(options.body);
        }
        
        req.end();
    }).catch(e => {
        console.error(`[FETCH EXCEPTION] ${url}: ${e.message}`);
        throw e;
    });
}

/**
 * CORE: Rewrite all URLs in content to go through our proxy
 * This is what makes it work like CroxyProxy!
 */
function rewriteUrls(content, baseUrl, proxyOrigin) {
    let html = content.toString('utf-8');
    const base = new URL(baseUrl);
    
    // Helper to convert any URL to our proxy format
    const toProxyUrl = (url) => {
        if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:') || url.startsWith('#')) {
            return url;
        }
        
        try {
            // Make absolute URL
            let absolute;
            if (url.startsWith('//')) {
                absolute = base.protocol + url;
            } else if (url.startsWith('/')) {
                absolute = base.origin + url;
            } else if (!url.includes('://')) {
                // Relative URL
                const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);
                absolute = base.origin + basePath + url;
            } else {
                absolute = url;
            }
            
            // CroxyProxy-style URL: /path?__cpo=BASE64
            try {
                const targetUrl = new URL(absolute);
                const proxyPath = targetUrl.pathname + (targetUrl.search ? targetUrl.search + '&' : '?') + '__cpo=' + encodeUrl(absolute);
                return proxyOrigin + proxyPath;
            } catch(e) {
                return `${proxyOrigin}/?__cpo=${encodeUrl(absolute)}`;
            }
        } catch (e) {
            return url;
        }
    };
    
    // 1. Rewrite <a href="...">
    html = html.replace(/(<a\s+[^>]*href\s*=\s*["'])([^"']+)(["'])/gi, (match, prefix, url, suffix) => {
        return prefix + toProxyUrl(url) + suffix;
    });
    
    // 2. Rewrite <link href="..."> (stylesheets)
    html = html.replace(/(<link\s+[^>]*href\s*=\s*["'])([^"']+)(["'])/gi, (match, prefix, url, suffix) => {
        return prefix + toProxyUrl(url) + suffix;
    });
    
    // 3. Rewrite <script src="...">
    html = html.replace(/(<script\s+[^>]*src\s*=\s*["'])([^"']+)(["'])/gi, (match, prefix, url, suffix) => {
        return prefix + toProxyUrl(url) + suffix;
    });
    
    // 4. Rewrite <img src="..."> and srcset
    html = html.replace(/(<img\s+[^>]*src\s*=\s*["'])([^"']+)(["'])/gi, (match, prefix, url, suffix) => {
        return prefix + toProxyUrl(url) + suffix;
    });
    
    // 5. Rewrite srcset attributes
    html = html.replace(/srcset\s*=\s*["']([^"']+)["']/gi, (match, srcset) => {
        const rewritten = srcset.split(',').map(part => {
            const [url, descriptor] = part.trim().split(/\s+/);
            return toProxyUrl(url) + (descriptor ? ' ' + descriptor : '');
        }).join(', ');
        return `srcset="${rewritten}"`;
    });
    
    // 6. Rewrite <video> and <audio> src
    html = html.replace(/(<(?:video|audio|source)\s+[^>]*src\s*=\s*["'])([^"']+)(["'])/gi, (match, prefix, url, suffix) => {
        return prefix + toProxyUrl(url) + suffix;
    });
    
    // 7. Rewrite <iframe src="...">
    html = html.replace(/(<iframe\s+[^>]*src\s*=\s*["'])([^"']+)(["'])/gi, (match, prefix, url, suffix) => {
        return prefix + toProxyUrl(url) + suffix;
    });
    
    // 8. Rewrite <form action="...">
    html = html.replace(/(<form\s+[^>]*action\s*=\s*["'])([^"']+)(["'])/gi, (match, prefix, url, suffix) => {
        return prefix + toProxyUrl(url) + suffix;
    });
    
    // 9. Rewrite url() in inline styles
    html = html.replace(/url\s*\(\s*["']?([^"'\)]+)["']?\s*\)/gi, (match, url) => {
        if (url.startsWith('data:')) return match;
        return `url("${toProxyUrl(url)}")`;
    });
    
    // 10. Rewrite meta refresh
    html = html.replace(/(<meta\s+[^>]*content\s*=\s*["'])(\d+;\s*url=)([^"']+)(["'])/gi, (match, prefix, time, url, suffix) => {
        return prefix + time + toProxyUrl(url) + suffix;
    });
    
    // 11. Base tag not needed - __cpo format handles relative URLs naturally
    // The path in URL already matches the real site's path
    
    // 12. Inject client-side JS interceptor for dynamic content
    const interceptorScript = `
<script>
(function() {
    var PROXY_ORIGIN = "${proxyOrigin}";
    var BASE_URL = "${baseUrl}";
    var BASE_ORIGIN = "${base.origin}";
    
    // Store CSRF tokens per domain - Roblox requires this!
    var csrfTokens = {};
    
    // ARKOSE/FUNCAPTCHA FIX: Create a global callback that Arkose can find
    // This ensures the captcha can communicate back to Roblox
    window.arkoseCallback = null;
    window.arkoseEnforcement = null;
    
    // Create a place to store Arkose data callbacks and script info
    window.__arkoseCallbacks = {};
    window.__arkoseScriptInfo = null; // Will store {callback: 'callbackName', src: 'original-url'}
    window.__arkosePendingScripts = []; // Queue of pending Arkose scripts
    
    // Shim for document.currentScript - Arkose api.js needs this
    // When it can't find currentScript, provide a fake script element with the callback
    var origCurrentScript = Object.getOwnPropertyDescriptor(Document.prototype, 'currentScript');
    if (origCurrentScript) {
        Object.defineProperty(document, 'currentScript', {
            get: function() {
                var real = origCurrentScript.get.call(document);
                if (real) return real;
                
                // If no current script but we have pending Arkose info, create a fake script element
                if (window.__arkoseScriptInfo) {
                    console.log('[PROXY] Creating fake currentScript for Arkose with callback:', window.__arkoseScriptInfo.callback);
                    var fakeScript = document.createElement('script');
                    fakeScript.src = window.__arkoseScriptInfo.src || '';
                    if (window.__arkoseScriptInfo.callback) {
                        fakeScript.setAttribute('data-callback', window.__arkoseScriptInfo.callback);
                    }
                    // Copy all other stored attributes
                    if (window.__arkoseScriptInfo.attributes) {
                        for (var attr in window.__arkoseScriptInfo.attributes) {
                            fakeScript.setAttribute(attr, window.__arkoseScriptInfo.attributes[attr]);
                        }
                    }
                    return fakeScript;
                }
                
                // Fallback: check for Arkose scripts in DOM
                var scripts = document.querySelectorAll('script[src*="arkose"], script[src*="funcaptcha"]');
                if (scripts.length > 0) {
                    var lastArkose = scripts[scripts.length - 1];
                    console.log('[PROXY] Returning Arkose script from DOM as currentScript');
                    return lastArkose;
                }
                return null;
            }
        });
    }
    
    // Encode URL to base64 - DEFINE FIRST so it can be used everywhere
    function encodeUrl(url) {
        try {
            return btoa(url).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
        } catch(e) {
            return btoa(unescape(encodeURIComponent(url))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
        }
    }
    
    // Convert URL to proxy format - DEFINE FIRST so createElement can use it
    function toProxyUrl(url) {
        if (!url) return url;
        var s = String(url);
        
        // Skip special URLs
        if (s.startsWith('data:') || s.startsWith('blob:') || s.startsWith('javascript:') || s.startsWith('#')) {
            return s;
        }
        
        // FIX: Normalize localhost URLs to match PROXY_ORIGIN protocol
        // When behind CF tunnel, PROXY_ORIGIN is https://...
        // When local, PROXY_ORIGIN is http://localhost:3003
        if (s.startsWith('https://localhost:') || s.startsWith('https://127.0.0.1:')) {
            // Check if PROXY_ORIGIN uses HTTPS (CF tunnel)
            if (PROXY_ORIGIN.startsWith('https://')) {
                // Keep HTTPS - we're behind CF tunnel
                console.log('[PROXY] Keeping HTTPS for CF tunnel URL:', s);
            } else {
                // Convert to HTTP for local development
                s = s.replace('https://', 'http://');
                console.log('[PROXY] Fixed HTTPS to HTTP for localhost:', s);
            }
        }
        
        // Skip already proxied (after HTTPS fix) - check for __cpo parameter
        if (s.includes('__cpo=')) return s;
        
        try {
            var absolute;
            if (s.startsWith('//')) {
                absolute = 'https:' + s;
            } else if (s.startsWith('/')) {
                absolute = BASE_ORIGIN + s;
            } else if (!s.includes('://')) {
                absolute = new URL(s, BASE_URL).href;
            } else {
                absolute = s;
            }
            
            // CRITICAL: Fix localhost URLs that got constructed with proxy origin!
            // This happens when code reads window.location.origin from the real URL bar
            if (absolute.includes('localhost:') || absolute.includes('127.0.0.1:')) {
                console.log('[PROXY] Fixing localhost URL:', absolute);
                try {
                    var localUrl = new URL(absolute);
                    // Check if URL has __cpo parameter - extract the REAL origin from it
                    var cpoMatch = localUrl.search.match(/[?&]__cpo=([A-Za-z0-9_-]+)/);
                    if (cpoMatch) {
                        // Decode the __cpo to get the real URL's origin
                        try {
                            var b64 = cpoMatch[1].replace(/-/g, '+').replace(/_/g, '/');
                            while (b64.length % 4) b64 += '=';
                            var realUrl = new URL(atob(b64));
                            // Use the origin from the decoded URL, not BASE_ORIGIN
                            var cleanPath = localUrl.pathname;
                            var cleanSearch = localUrl.search.replace(/[?&]__cpo=[A-Za-z0-9_-]+/, '').replace(/^&/, '?').replace(/^\?$/, '');
                            absolute = realUrl.origin + cleanPath + cleanSearch;
                            console.log('[PROXY] Fixed localhost URL using __cpo origin:', absolute);
                        } catch(decodeErr) {
                            // Fallback to BASE_ORIGIN if decode fails
                            absolute = BASE_ORIGIN + localUrl.pathname + localUrl.search.replace(/[?&]__cpo=[A-Za-z0-9_-]+/, '');
                            console.log('[PROXY] Fixed localhost URL using BASE_ORIGIN:', absolute);
                        }
                    } else {
                        // No __cpo, use BASE_ORIGIN
                        absolute = BASE_ORIGIN + localUrl.pathname + localUrl.search;
                        console.log('[PROXY] Fixed to:', absolute);
                    }
                } catch(e) {
                    console.warn('[PROXY] Failed to fix localhost URL:', e);
                }
            }
            
            // CroxyProxy-style URL: /path?__cpo=BASE64
            var targetUrl = new URL(absolute);
            var proxyPath = targetUrl.pathname + (targetUrl.search ? targetUrl.search + '&' : '?') + '__cpo=' + encodeUrl(absolute);
            return PROXY_ORIGIN + proxyPath;
        } catch(e) {
            return s;
        }
    }
    
    // CRITICAL: Spoof window.location for captcha (FunCaptcha/Arkose) to work!
    // Captcha checks hostname and must see the real domain, not localhost
    try {
        var fakeUrl = new URL(BASE_URL);
        var fakeLocation = {
            href: fakeUrl.href,
            hostname: fakeUrl.hostname,
            host: fakeUrl.host,
            origin: fakeUrl.origin,
            protocol: fakeUrl.protocol,
            pathname: fakeUrl.pathname || '/',
            search: fakeUrl.search || '',
            hash: '',
            port: fakeUrl.port || '',
            ancestorOrigins: [],
            assign: function(url) { try { var u = new URL(url); window.location.href = u.pathname + (u.search ? u.search + '&' : '?') + '__cpo=' + btoa(url).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,''); } catch(e) { window.location.href = '/?__cpo=' + btoa(url).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,''); } },
            reload: function() { window.location.reload(); },
            replace: function(url) { try { var u = new URL(url); window.location.replace(u.pathname + (u.search ? u.search + '&' : '?') + '__cpo=' + btoa(url).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'')); } catch(e) { window.location.replace('/?__cpo=' + btoa(url).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'')); } },
            toString: function() { return fakeUrl.href; }
        };
        
        // With __cpo format, URL path is already the real path - no spoofing needed!
        // React Router sees /explore (real path) not /browse/xxx
        console.log('[PROXY] CroxyProxy-style URL - path is already real:', window.location.pathname);
        
        // Override location on window
        Object.defineProperty(window, '__spoofedLocation', { value: fakeLocation, writable: false });
        
        // Try to override document.location and window.location getters
        try {
            Object.defineProperty(document, 'location', { get: function() { return fakeLocation; } });
        } catch(e) {}
        
        // Override document.domain
        try {
            Object.defineProperty(document, 'domain', { get: function() { return fakeUrl.hostname; }, set: function() {} });
        } catch(e) {}
        
        // Override location checks in iframes
        var origCreateElement = document.createElement.bind(document);
        document.createElement = function(tag) {
            var el = origCreateElement(tag);
            var tagLower = tag.toLowerCase();
            
            if (tagLower === 'iframe') {
                el.addEventListener('load', function() {
                    try {
                        Object.defineProperty(el.contentWindow, 'location', { get: function() { return fakeLocation; } });
                    } catch(e) {}
                });
            }
            
            // CRITICAL: Intercept script creation to rewrite src URLs!
            // This catches dynamically created scripts like FunCaptcha/Arkose
            if (tagLower === 'script') {
                var origSetAttribute = el.setAttribute.bind(el);
                var scriptAttributes = {}; // Store attributes for Arkose
                var isArkoseScript = false;
                
                el.setAttribute = function(name, value) {
                    // Store data attributes - Arkose needs these!
                    if (name.startsWith('data-')) {
                        scriptAttributes[name] = value;
                        // Actually set on element too so DOM queries find it
                        origSetAttribute(name, value);
                    }
                    if (name === 'src' && value && !value.includes('__cpo=')) {
                        var newSrc = toProxyUrl(value);
                        console.log('[PROXY] Script src intercepted:', value, '->', newSrc);
                        
                        // For Arkose scripts, store info GLOBALLY before script loads!
                        if (value.includes('arkose') || value.includes('funcaptcha')) {
                            isArkoseScript = true;
                            console.log('[PROXY] Arkose script detected! Storing global info with attributes:', JSON.stringify(scriptAttributes));
                            
                            // CRITICAL: Store globally so currentScript shim can access it
                            window.__arkoseScriptInfo = {
                                src: value,
                                callback: scriptAttributes['data-callback'] || null,
                                attributes: Object.assign({}, scriptAttributes)
                            };
                            
                            // Also store the original URL so Arkose can identify itself
                            el._originalSrc = value;
                            el._proxyAttributes = scriptAttributes;
                        }
                        return origSetAttribute(name, newSrc);
                    }
                    return origSetAttribute(name, value);
                };
                
                // Also intercept direct .src assignment
                var srcDescriptor = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
                if (srcDescriptor) {
                    Object.defineProperty(el, 'src', {
                        get: function() { return srcDescriptor.get.call(el); },
                        set: function(value) {
                            if (value && !value.includes('__cpo=')) {
                                var newSrc = toProxyUrl(value);
                                console.log('[PROXY] Script .src set intercepted:', value, '->', newSrc);
                                
                                // For Arkose scripts, store info GLOBALLY!
                                if (value.includes('arkose') || value.includes('funcaptcha')) {
                                    isArkoseScript = true;
                                    console.log('[PROXY] Arkose script (.src) detected! Storing global info with attributes:', JSON.stringify(scriptAttributes));
                                    
                                    window.__arkoseScriptInfo = {
                                        src: value,
                                        callback: scriptAttributes['data-callback'] || null,
                                        attributes: Object.assign({}, scriptAttributes)
                                    };
                                    
                                    el._originalSrc = value;
                                    el._proxyAttributes = scriptAttributes;
                                }
                                return srcDescriptor.set.call(el, newSrc);
                            }
                            return srcDescriptor.set.call(el, value);
                        }
                    });
                }
            }
            
            // Intercept link elements (stylesheets)
            if (tagLower === 'link') {
                var origSetAttrLink = el.setAttribute.bind(el);
                el.setAttribute = function(name, value) {
                    if (name === 'href' && value && !value.includes('__cpo=')) {
                        var newHref = toProxyUrl(value);
                        console.log('[PROXY] Link href intercepted:', value, '->', newHref);
                        return origSetAttrLink(name, newHref);
                    }
                    return origSetAttrLink(name, value);
                };
            }
            
            // Intercept img elements
            if (tagLower === 'img') {
                var origSetAttrImg = el.setAttribute.bind(el);
                el.setAttribute = function(name, value) {
                    if (name === 'src' && value && !value.includes('__cpo=') && !value.startsWith('data:')) {
                        return origSetAttrImg(name, toProxyUrl(value));
                    }
                    return origSetAttrImg(name, value);
                };
            }
            
            return el;
        };
        
        console.log('[PROXY] Location spoofed to: ' + fakeUrl.hostname);
    } catch(e) {
        console.warn('[PROXY] Location spoof failed:', e);
    }
    
    // CRITICAL: Intercept URL constructor to fix localhost-based URL construction
    // TikTok's code does things like: new URL('/api/path', window.location.origin)
    var OriginalURL = window.URL;
    window.URL = function(url, base) {
        var urlStr = String(url);
        
        // IMPORTANT: If URL already contains __cpo=, it's already a proxy URL - leave it alone!
        if (urlStr.includes('__cpo=')) {
            return new OriginalURL(urlStr, base);
        }
        
        // If base is provided and is localhost, replace with BASE_ORIGIN
        if (base !== undefined) {
            var baseStr = String(base);
            // But only if base doesn't contain __cpo= (not already proxied)
            if (!baseStr.includes('__cpo=') && (baseStr.includes('localhost:') || baseStr.includes('127.0.0.1:'))) {
                console.log('[PROXY] Fixing URL constructor base:', baseStr, '->', BASE_ORIGIN);
                base = BASE_ORIGIN;
            }
        }
        
        // If url is absolute localhost URL without __cpo=, fix it
        if ((urlStr.startsWith('http://localhost:') || urlStr.startsWith('http://127.0.0.1:')) && !urlStr.includes('__cpo=')) {
            try {
                var localUrl = new OriginalURL(urlStr);
                urlStr = BASE_ORIGIN + localUrl.pathname + localUrl.search;
                console.log('[PROXY] Fixed URL constructor url:', url, '->', urlStr);
            } catch(e) {}
        }
        
        return new OriginalURL(urlStr, base);
    };
    // Preserve URL statics
    window.URL.createObjectURL = OriginalURL.createObjectURL;
    window.URL.revokeObjectURL = OriginalURL.revokeObjectURL;
    window.URL.prototype = OriginalURL.prototype;
    
    // Get domain from URL
    function getDomain(url) {
        try {
            return new OriginalURL(url).hostname;
        } catch(e) {
            return 'unknown';
        }
    }
    
    // Intercept fetch - with CSRF token retry for Roblox!
    var origFetch = window.fetch;
    window.fetch = function(input, init) {
        var url = (input instanceof Request) ? input.url : String(input);
        
        // CRITICAL FIX: Convert https://localhost to http://localhost FIRST
        // TikTok's privacy framework wraps fetch and sometimes converts to HTTPS
        if (url.startsWith('https://localhost:') || url.startsWith('https://127.0.0.1:')) {
            url = url.replace('https://', 'http://');
            console.log('[PROXY FETCH] Fixed HTTPS to HTTP:', url);
        }
        
        var originalUrl = url;
        var proxied = toProxyUrl(url);
        
        // Determine the target domain for CSRF
        var domain;
        try {
            var targetUrl = url.includes('__cpo=') ? url : (url.startsWith('http') ? url : BASE_ORIGIN + (url.startsWith('/') ? '' : '/') + url);
            // Extract domain - if has __cpo=, decode it; otherwise use URL directly
            if (targetUrl.includes('__cpo=')) {
                var cpoMatch = targetUrl.match(/__cpo=([A-Za-z0-9+/=_-]+)/);
                if (cpoMatch) {
                    domain = getDomain(atob(cpoMatch[1].replace(/-/g,'+').replace(/_/g,'/')));
                } else {
                    domain = getDomain(targetUrl);
                }
            } else {
                domain = getDomain(targetUrl);
            }
        } catch(e) { domain = 'roblox.com'; }
        
        init = init || {};
        init.headers = init.headers || {};
        
        // Convert Headers object to plain object if needed
        if (init.headers instanceof Headers) {
            var h = {};
            init.headers.forEach(function(v, k) { h[k] = v; });
            init.headers = h;
        }
        
        // Add stored CSRF token if we have one for this domain
        if (csrfTokens[domain]) {
            init.headers['x-csrf-token'] = csrfTokens[domain];
        }
        
        // Add credentials to send cookies
        init.credentials = init.credentials || 'include';
        
        if (input instanceof Request) {
            input = new Request(proxied, input);
        } else {
            input = proxied;
        }
        
        return origFetch.call(this, input, init).then(function(response) {
            // Store CSRF token from response
            var token = response.headers.get('x-csrf-token');
            if (token) {
                csrfTokens[domain] = token;
                console.log('[PROXY] Got CSRF token for ' + domain);
                
                // Check for challenge headers - DON'T retry those!
                var challengeId = response.headers.get('rblx-challenge-id');
                var challengeType = response.headers.get('rblx-challenge-type');
                
                if (challengeId || challengeType) {
                    console.log('[PROXY FETCH] Challenge required (id=' + challengeId + ', type=' + challengeType + ') - NOT retrying');
                    return response; // Let Roblox code handle the challenge
                }
                
                // If we got a 403 with a new token (and NOT a challenge), RETRY the request
                if (response.status === 403 && init.method && init.method.toUpperCase() !== 'GET') {
                    // Clone response to check body for challenge
                    return response.clone().text().then(function(body) {
                        if (body.includes('challenge') || body.includes('Challenge') || body.includes('captcha')) {
                            console.log('[PROXY FETCH] Challenge in response body - NOT retrying');
                            return response; // Return original response for Roblox to handle
                        }
                        console.log('[PROXY FETCH] Retrying with CSRF token...');
                        init.headers['x-csrf-token'] = token;
                        return origFetch.call(window, input, init);
                    });
                }
            }
            return response;
        });
    };
    
    // Intercept XMLHttpRequest with CSRF support and AUTO-RETRY on 403!
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    
    XMLHttpRequest.prototype.open = function(method, url) {
        this._proxyMethod = method;
        this._proxyUrl = url;
        this._originalUrl = url;
        this._proxyHeaders = {};
        arguments[1] = toProxyUrl(url);
        this._proxiedUrl = arguments[1];
        return origOpen.apply(this, arguments);
    };
    
    // Override setRequestHeader to capture headers for retry
    XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
        this._proxyHeaders = this._proxyHeaders || {};
        this._proxyHeaders[name] = value;
        return origSetHeader.apply(this, arguments);
    };
    
    XMLHttpRequest.prototype.send = function(body) {
        var xhr = this;
        var domain;
        var method = this._proxyMethod || 'GET';
        var proxiedUrl = this._proxiedUrl;
        var headers = this._proxyHeaders || {};
        var originalBody = body;
        
        try {
            var url = this._originalUrl || '';
            var targetUrl = url.includes('__cpo=') ? url : (url.startsWith('http') ? url : BASE_ORIGIN + (url.startsWith('/') ? '' : '/') + url);
            // Extract domain - if has __cpo=, decode it; otherwise use URL directly
            if (targetUrl.includes('__cpo=')) {
                var cpoMatch = targetUrl.match(/__cpo=([A-Za-z0-9+/=_-]+)/);
                if (cpoMatch) {
                    domain = getDomain(atob(cpoMatch[1].replace(/-/g,'+').replace(/_/g,'/')));
                } else {
                    domain = getDomain(targetUrl);
                }
            } else {
                domain = getDomain(targetUrl);
            }
        } catch(e) { domain = 'roblox.com'; }
        
        // Add CSRF token if we have one
        if (csrfTokens[domain] && !headers['x-csrf-token']) {
            try { origSetHeader.call(this, 'x-csrf-token', csrfTokens[domain]); } catch(e) {}
        }
        
        // Store original callbacks
        var origOnLoad = this.onload;
        var origOnReady = this.onreadystatechange;
        var origOnError = this.onerror;
        var hasRetried = false;
        
        // Override onreadystatechange to handle 403 + CSRF retry
        this.onreadystatechange = function() {
            if (xhr.readyState === 4) {
                var token = xhr.getResponseHeader('x-csrf-token');
                if (token) {
                    csrfTokens[domain] = token;
                    console.log('[PROXY XHR] Got CSRF token for ' + domain + ': ' + token.substring(0, 20) + '...');
                }
                
                // Check if this is SPECIFICALLY a captcha/challenge 403 response
                // Only check on 403 status, and look for specific Roblox challenge indicators
                var isCaptchaChallenge = false;
                if (xhr.status === 403) {
                    var challengeId = xhr.getResponseHeader('rblx-challenge-id');
                    var challengeType = xhr.getResponseHeader('rblx-challenge-type');
                    
                    if (challengeId || challengeType) {
                        isCaptchaChallenge = true;
                        console.log('[PROXY XHR] Captcha challenge detected! id=' + challengeId + ', type=' + challengeType);
                    } else {
                        // Also check response body for specific captcha message
                        var responseText = '';
                        try { responseText = xhr.responseText || ''; } catch(e) {}
                        if (responseText.includes('Challenge is required') || 
                            responseText.includes('"captcha"') ||
                            responseText.includes('arkose')) {
                            isCaptchaChallenge = true;
                            console.log('[PROXY XHR] Captcha challenge detected in response body');
                        }
                    }
                }
                
                if (isCaptchaChallenge) {
                    console.log('[PROXY XHR] Letting Roblox handle captcha challenge');
                    // Let the original callback handle the challenge response
                    if (origOnReady) origOnReady.call(this);
                    return;
                }
                
                // Auto-retry on 403 with new CSRF token for non-GET requests (but NOT captcha challenges!)
                if (xhr.status === 403 && token && !hasRetried && method.toUpperCase() !== 'GET') {
                    hasRetried = true;
                    console.log('[PROXY XHR] Got 403 (CSRF issue), retrying with new token...');
                    
                    // Create new XHR with the token
                    var retryXhr = new XMLHttpRequest();
                    retryXhr.open(method, proxiedUrl, true);
                    
                    // Copy original headers
                    for (var h in headers) {
                        try { retryXhr.setRequestHeader(h, headers[h]); } catch(e) {}
                    }
                    // Set the new CSRF token
                    retryXhr.setRequestHeader('x-csrf-token', token);
                    
                    // Copy callbacks
                    retryXhr.onload = origOnLoad;
                    retryXhr.onerror = origOnError;
                    retryXhr.onreadystatechange = function() {
                        // Mirror properties to original xhr so callbacks work
                        if (retryXhr.readyState === 4) {
                            // Store any new token from retry
                            var newToken = retryXhr.getResponseHeader('x-csrf-token');
                            if (newToken) csrfTokens[domain] = newToken;
                        }
                        if (origOnReady) {
                            // Call with retry xhr context
                            origOnReady.call(retryXhr);
                        }
                    };
                    
                    retryXhr.send(originalBody);
                    return; // Don't call original callback for 403
                }
            }
            if (origOnReady) origOnReady.call(this);
        };
        
        this.onload = function() {
            var token = xhr.getResponseHeader('x-csrf-token');
            if (token) {
                csrfTokens[domain] = token;
            }
            if (origOnLoad && !hasRetried) origOnLoad.apply(this, arguments);
        };
        
        return origSend.call(this, body);
    };
    
    // Intercept window.open
    var origWindowOpen = window.open;
    window.open = function(url, name, features) {
        return origWindowOpen.call(this, toProxyUrl(url), name, features);
    };
    
    // Intercept location changes
    var locationDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
    
    // Intercept document.write to rewrite URLs
    var origWrite = document.write;
    document.write = function(html) {
        // Simple URL rewriting in written content
        if (typeof html === 'string') {
            html = html.replace(/(href|src|action)\\s*=\\s*["']([^"']+)["']/gi, function(match, attr, url) {
                return attr + '="' + toProxyUrl(url) + '"';
            });
        }
        return origWrite.call(this, html);
    };
    
    // Handle form submissions
    document.addEventListener('submit', function(e) {
        var form = e.target;
        if (form.action && !form.action.includes('__cpo=')) {
            form.action = toProxyUrl(form.action);
        }
    }, true);
    
    // Handle clicks on links
    document.addEventListener('click', function(e) {
        var target = e.target.closest('a');
        if (target && target.href && !target.href.includes('__cpo=')) {
            e.preventDefault();
            window.location.href = toProxyUrl(target.href);
        }
    }, true);
    
    // With CroxyProxy-style URLs, history API doesn't need special handling!
    // The URL path is already the real path, SPA routing works naturally
    
    // Intercept Worker creation for captcha support!
    var OriginalWorker = window.Worker;
    window.Worker = function(scriptUrl, options) {
        console.log('[PROXY] Worker intercepted:', scriptUrl);
        var proxiedUrl = toProxyUrl(scriptUrl);
        
        // CRITICAL: Module workers can't use importScripts()!
        // If we detect a module worker that might need importScripts, convert to classic
        if (options && options.type === 'module') {
            console.log('[PROXY] Module worker detected - checking if we should convert to classic...');
            // For Arkose/FunCaptcha workers, we need classic workers
            if (scriptUrl.includes('arkose') || scriptUrl.includes('funcaptcha') || scriptUrl.includes('arkoselabs')) {
                console.log('[PROXY] Arkose worker - converting to classic worker');
                options = Object.assign({}, options);
                delete options.type; // Remove type: module to use classic worker
            }
        }
        
        try {
            return new OriginalWorker(proxiedUrl, options);
        } catch(e) {
            console.error('[PROXY] Worker creation failed:', e);
            // Try without module type as fallback
            if (options && options.type === 'module') {
                console.log('[PROXY] Retrying without module type...');
                var newOptions = Object.assign({}, options);
                delete newOptions.type;
                return new OriginalWorker(proxiedUrl, newOptions);
            }
            throw e;
        }
    };
    window.Worker.prototype = OriginalWorker.prototype;
    
    // Intercept SharedWorker too
    if (window.SharedWorker) {
        var OriginalSharedWorker = window.SharedWorker;
        window.SharedWorker = function(scriptUrl, options) {
            console.log('[PROXY] SharedWorker intercepted:', scriptUrl);
            return new OriginalSharedWorker(toProxyUrl(scriptUrl), options);
        };
        window.SharedWorker.prototype = OriginalSharedWorker.prototype;
    }
    
    // Intercept postMessage to parent for captcha communication
    var origPostMessage = window.postMessage;
    window.postMessage = function(message, targetOrigin, transfer) {
        // Allow captcha postMessage to work by accepting any origin
        if (targetOrigin && targetOrigin !== '*' && !targetOrigin.includes(window.location.host)) {
            console.log('[PROXY] postMessage origin spoofed:', targetOrigin, '->', '*');
            targetOrigin = '*';
        }
        return origPostMessage.call(this, message, targetOrigin, transfer);
    };
    
    // Add message event listener to handle cross-origin captcha responses
    window.addEventListener('message', function(e) {
        // Log captcha-related messages for debugging
        if (e.data && (e.data.type === 'arkose' || e.data.arkose || e.data.fc)) {
            console.log('[PROXY] Captcha message received:', e.data);
        }
    });
    
    // Fix for api.js getAttribute error - ensure data attributes exist (wait for body)
    function ensureBodyAttributes() {
        if (document.body) {
            if (!document.body.dataset.blobUrl) {
                document.body.dataset.blobUrl = '';
            }
        } else {
            // Body not ready, wait for it
            document.addEventListener('DOMContentLoaded', function() {
                if (document.body && !document.body.dataset.blobUrl) {
                    document.body.dataset.blobUrl = '';
                }
            });
        }
    }
    ensureBodyAttributes();
    
    // ARKOSE FIX: Ensure global callbacks are defined for FunCaptcha
    // Roblox uses these to communicate with the captcha
    if (typeof window.onArkoseEnforcementLoaded === 'undefined') {
        window.onArkoseEnforcementLoaded = function(enforcement) {
            console.log('[PROXY] Arkose enforcement loaded, storing reference');
            window.__arkoseEnforcement = enforcement;
            // Trigger any waiting callbacks
            if (window.__arkosePendingCallback) {
                window.__arkosePendingCallback(enforcement);
            }
        };
    }
    
    // Also define common Arkose callback names that Roblox might use
    if (typeof window.arkoseEnforcementReady === 'undefined') {
        window.arkoseEnforcementReady = function(enforcement) {
            console.log('[PROXY] Arkose ready callback triggered');
            window.__arkoseEnforcement = enforcement;
        };
    }
    
    // Hook into Arkose's enforcement.setConfig to see what's happening
    var checkArkoseInterval = setInterval(function() {
        if (window.ArkoseEnforcement || window.enforcement) {
            console.log('[PROXY] Arkose object detected!');
            clearInterval(checkArkoseInterval);
        }
    }, 500);
    
    // After 10 seconds, stop checking
    setTimeout(function() { clearInterval(checkArkoseInterval); }, 10000);
    
    console.log('[PROXY] Client-side interceptor active (with Worker & captcha support)');
})();
</script>`;

    // With CroxyProxy-style URLs (/path?__cpo=), no early spoofing needed!
    // The URL path is already correct (e.g., /explore not /browse/xxx)
    // BUT we MUST intercept fetch EARLY before any other scripts run!
    // AND we must make it UNBYPASSABLE so other scripts can't override it!
    const earlySpoof = `<script>
// CRITICAL: Early fetch/XHR interceptor - UNBYPASSABLE version
(function(){
    var PROXY_ORIGIN = "${proxyOrigin}";
    var BASE_URL = "${baseUrl}";
    var BASE_ORIGIN = new URL(BASE_URL).origin;
    
    console.log('[PROXY] Early interceptor loading - BASE_ORIGIN:', BASE_ORIGIN);
    
    // Encode URL to base64
    function encodeUrl(url) {
        try {
            return btoa(url).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
        } catch(e) {
            return btoa(unescape(encodeURIComponent(url))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
        }
    }
    
    // Convert any URL to proxy format
    function toProxyUrl(url) {
        if (!url) return url;
        var s = String(url);
        
        // Skip special URLs
        if (s.startsWith('data:') || s.startsWith('blob:') || s.startsWith('javascript:') || s.startsWith('#')) {
            return s;
        }
        
        // Skip already proxied
        if (s.includes('__cpo=')) return s;
        
        // Skip localhost proxy URLs
        if (s.includes('localhost:') && s.includes('__cpo=')) return s;
        
        // Fix HTTPS localhost
        if (s.startsWith('https://localhost:') || s.startsWith('https://127.0.0.1:')) {
            s = s.replace('https://', 'http://');
        }
        
        try {
            var absolute;
            if (s.startsWith('//')) {
                absolute = 'https:' + s;
            } else if (s.startsWith('/')) {
                absolute = BASE_ORIGIN + s;
            } else if (!s.includes('://')) {
                absolute = new URL(s, BASE_URL).href;
            } else {
                absolute = s;
            }
            
            // Fix localhost URLs that aren't our proxy
            if ((absolute.includes('localhost:') || absolute.includes('127.0.0.1:')) && !absolute.includes(':3003')) {
                var localUrl = new URL(absolute);
                absolute = BASE_ORIGIN + localUrl.pathname + localUrl.search;
            }
            
            // CroxyProxy-style: /path?__cpo=BASE64
            var targetUrl = new URL(absolute);
            var sep = targetUrl.search ? '&' : '?';
            return PROXY_ORIGIN + targetUrl.pathname + targetUrl.search + sep + '__cpo=' + encodeUrl(absolute);
        } catch(e) {
            return s;
        }
    }
    
    // CRITICAL: Save the TRUE native fetch - bind it to window
    var TRUE_NATIVE_FETCH = window.fetch.bind(window);
    
    // Our proxy fetch function
    function proxyFetch(input, init) {
        var url = (input instanceof Request) ? input.url : String(input);
        var proxiedUrl = toProxyUrl(url);
        
        if (input instanceof Request) {
            input = new Request(proxiedUrl, input);
        } else {
            input = proxiedUrl;
        }
        
        // Ensure credentials are included
        init = init || {};
        init.credentials = init.credentials || 'include';
        
        // ALWAYS use TRUE native fetch - never any wrapper!
        return TRUE_NATIVE_FETCH(input, init);
    }
    
    // Store our proxy fetch globally so we can always access it
    window.__PROXY_FETCH__ = proxyFetch;
    window.__TRUE_FETCH__ = TRUE_NATIVE_FETCH;
    window.__toProxyUrl__ = toProxyUrl;
    
    // Set our fetch and LOCK it with Object.defineProperty
    Object.defineProperty(window, 'fetch', {
        configurable: true, // Allow reconfiguration (needed for some sites)
        enumerable: true,
        get: function() {
            return window.__PROXY_FETCH__;
        },
        set: function(newFetch) {
            // When another script tries to wrap fetch, wrap THEIR wrapper with our proxy
            console.log('[PROXY] Another script tried to override fetch - wrapping it');
            var wrappedFetch = newFetch;
            window.__PROXY_FETCH__ = function(input, init) {
                var url = (input instanceof Request) ? input.url : String(input);
                var proxiedUrl = toProxyUrl(url);
                
                if (input instanceof Request) {
                    input = new Request(proxiedUrl, input);
                } else {
                    input = proxiedUrl;
                }
                
                init = init || {};
                init.credentials = init.credentials || 'include';
                
                // Call their wrapper with proxied URL, but ensure it uses our true fetch
                return TRUE_NATIVE_FETCH(input, init);
            };
        }
    });
    
    // CRITICAL: Save native XMLHttpRequest methods IMMEDIATELY
    var XHROpen = XMLHttpRequest.prototype.open;
    var XHRSend = XMLHttpRequest.prototype.send;
    
    // Override XHR.open
    XMLHttpRequest.prototype.open = function(method, url) {
        this.__originalUrl = url;
        this.__proxiedUrl = toProxyUrl(url);
        arguments[1] = this.__proxiedUrl;
        return XHROpen.apply(this, arguments);
    };
    
    // Also protect XHR with defineProperty
    Object.defineProperty(XMLHttpRequest.prototype, 'open', {
        configurable: true,
        enumerable: true,
        writable: false,
        value: function(method, url) {
            this.__originalUrl = url;
            this.__proxiedUrl = toProxyUrl(url);
            var args = Array.prototype.slice.call(arguments);
            args[1] = this.__proxiedUrl;
            return XHROpen.apply(this, args);
        }
    });
    
    console.log('[PROXY] UNBYPASSABLE fetch/XHR interceptor installed');
})();
</script>`;
    
    // Inject EARLY spoof right after <head> (MUST be first script!)
    if (html.includes('<head>')) {
        html = html.replace('<head>', '<head>' + earlySpoof);
    } else if (html.includes('<head ')) {
        html = html.replace(/<head([^>]*)>/i, '<head$1>' + earlySpoof);
    }
    
    // Inject main interceptor at end of head
    if (html.includes('</head>')) {
        html = html.replace('</head>', interceptorScript + '</head>');
    } else if (html.includes('<body')) {
        html = html.replace(/<body([^>]*)>/i, '<body$1>' + interceptorScript);
    } else {
        html = interceptorScript + html;
    }
    
    return html;
}

/**
 * Rewrite CSS content
 */
function rewriteCss(content, baseUrl, proxyOrigin) {
    let css = content.toString('utf-8');
    const base = new URL(baseUrl);
    
    // Rewrite url() references - use CroxyProxy-style format
    css = css.replace(/url\s*\(\s*["']?([^"'\)]+)["']?\s*\)/gi, (match, url) => {
        if (url.startsWith('data:')) return match;
        
        let absolute;
        if (url.startsWith('//')) {
            absolute = base.protocol + url;
        } else if (url.startsWith('/')) {
            absolute = base.origin + url;
        } else if (!url.includes('://')) {
            const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);
            absolute = base.origin + basePath + url;
        } else {
            absolute = url;
        }
        
        // CroxyProxy-style: /path?__cpo=BASE64
        try {
            const targetUrl = new URL(absolute);
            const proxyPath = targetUrl.pathname + (targetUrl.search ? targetUrl.search + '&' : '?') + '__cpo=' + encodeUrl(absolute);
            return `url("${proxyOrigin}${proxyPath}")`;
        } catch(e) {
            return `url("${proxyOrigin}/?__cpo=${encodeUrl(absolute)}")`;
        }
    });
    
    // Rewrite @import - use CroxyProxy-style format
    css = css.replace(/@import\s+["']([^"']+)["']/gi, (match, url) => {
        let absolute;
        if (url.startsWith('//')) {
            absolute = base.protocol + url;
        } else if (url.startsWith('/')) {
            absolute = base.origin + url;
        } else if (!url.includes('://')) {
            const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);
            absolute = base.origin + basePath + url;
        } else {
            absolute = url;
        }
        // CroxyProxy-style: /path?__cpo=BASE64
        try {
            const targetUrl = new URL(absolute);
            const proxyPath = targetUrl.pathname + (targetUrl.search ? targetUrl.search + '&' : '?') + '__cpo=' + encodeUrl(absolute);
            return `@import "${proxyOrigin}${proxyPath}"`;
        } catch(e) {
            return `@import "${proxyOrigin}/?__cpo=${encodeUrl(absolute)}"`;
        }
    });
    
    return css;
}

/**
 * Rewrite JavaScript content - needed for Web Workers and importScripts!
 */
function rewriteJs(content, baseUrl, proxyOrigin) {
    let js = content.toString('utf-8');
    const base = new URL(baseUrl);
    
    // ARKOSE FIX: Patch document.currentScript usage in Arkose api.js
    // This is the critical fix - Arkose uses currentScript to get data-callback
    if (baseUrl.includes('arkoselabs') || baseUrl.includes('funcaptcha')) {
        console.log('[PROXY] Patching Arkose api.js for currentScript compatibility');
        
        // Create a robust fallback that:
        // 1. Uses our global __arkoseScriptInfo if available (set by client interceptor BEFORE script loads)
        // 2. Falls back to finding script in DOM
        // 3. Creates a fake script element with the stored callback if nothing else works
        const currentScriptPatch = `(function(){
            var cs = document.currentScript;
            if (cs) return cs;
            if (window.__arkoseScriptInfo) {
                var fake = document.createElement('script');
                fake.src = window.__arkoseScriptInfo.src || '';
                if (window.__arkoseScriptInfo.callback) fake.setAttribute('data-callback', window.__arkoseScriptInfo.callback);
                if (window.__arkoseScriptInfo.attributes) {
                    for (var k in window.__arkoseScriptInfo.attributes) {
                        fake.setAttribute(k, window.__arkoseScriptInfo.attributes[k]);
                    }
                }
                return fake;
            }
            return document.querySelector('script[src*="arkose"]') || document.querySelector('script[src*="funcaptcha"]') || document.querySelector('script[data-callback]');
        })()`;
        
        // Replace document.currentScript with our patch
        js = js.replace(/document\.currentScript/g, currentScriptPatch);
        
        // Also handle this.currentScript  
        js = js.replace(/this\.currentScript/g, currentScriptPatch);
    }
    
    // Rewrite importScripts() calls - critical for Web Workers!
    // importScripts('/path/to/script.js') -> importScripts('PROXY_ORIGIN/path?__cpo=BASE64')
    js = js.replace(/importScripts\s*\(([^)]+)\)/g, (match, args) => {
        // Parse the arguments and rewrite each URL
        const rewrittenArgs = args.split(',').map(arg => {
            const trimmed = arg.trim();
            // Check if it's a string literal
            const strMatch = trimmed.match(/^["'`]([^"'`]+)["'`]$/);
            if (strMatch) {
                const url = strMatch[1];
                if (url.startsWith('data:') || url.startsWith('blob:')) return trimmed;
                
                let absolute;
                if (url.startsWith('//')) {
                    absolute = base.protocol + url;
                } else if (url.startsWith('/')) {
                    absolute = base.origin + url;
                } else if (!url.includes('://')) {
                    const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);
                    absolute = base.origin + basePath + url;
                } else {
                    absolute = url;
                }
                try {
                    const targetUrl = new URL(absolute);
                    return `"${proxyOrigin}${targetUrl.pathname}?__cpo=${encodeUrl(absolute)}"`;
                } catch { return trimmed; }
            }
            return trimmed; // Dynamic URL - can't rewrite statically
        }).join(', ');
        return `importScripts(${rewrittenArgs})`;
    });
    
    // Rewrite new Worker() calls
    js = js.replace(/new\s+Worker\s*\(\s*["'`]([^"'`]+)["'`]/g, (match, url) => {
        if (url.startsWith('data:') || url.startsWith('blob:')) return match;
        
        let absolute;
        if (url.startsWith('//')) {
            absolute = base.protocol + url;
        } else if (url.startsWith('/')) {
            absolute = base.origin + url;
        } else if (!url.includes('://')) {
            const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);
            absolute = base.origin + basePath + url;
        } else {
            absolute = url;
        }
        const targetUrl = new URL(absolute);
        return `new Worker("${proxyOrigin}${targetUrl.pathname}?__cpo=${encodeUrl(absolute)}"`;
    });
    
    // Rewrite fetch() URLs in workers
    js = js.replace(/fetch\s*\(\s*["'`](\/[^"'`]+)["'`]/g, (match, url) => {
        const absolute = base.origin + url;
        const targetUrl = new URL(absolute);
        return `fetch("${proxyOrigin}${targetUrl.pathname}?__cpo=${encodeUrl(absolute)}"`;
    });
    
    // Rewrite XMLHttpRequest URLs
    js = js.replace(/\.open\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*["'`](\/[^"'`]+)["'`]/g, (match, method, url) => {
        const absolute = base.origin + url;
        const targetUrl = new URL(absolute);
        return `.open("${method}", "${proxyOrigin}${targetUrl.pathname}?__cpo=${encodeUrl(absolute)}"`;
    });
    
    // For Arkose/captcha scripts: also rewrite absolute URLs to their domains
    const captchaDomains = ['arkoselabs.com', 'funcaptcha.com', 'roblox.com', 'arkoselabs.roblox.com'];
    captchaDomains.forEach(domain => {
        // Rewrite full URLs for captcha domains
        js = js.replace(new RegExp(`["'\`](https?://${domain.replace('.', '\\.')}[^"'\`]*)["'\`]`, 'g'), (match, url) => {
            try {
                const targetUrl = new URL(url);
                return `"${proxyOrigin}${targetUrl.pathname}?__cpo=${encodeUrl(url)}"`;
            } catch { return match; }
        });
    });
    
    // ========== FIX: Rewrite relative URLs like "./core.js" to absolute URLs ==========
    // This is critical for TikTok's privacy framework loader which uses ./core.js
    // Without this, the browser resolves ./ relative to the PAGE, not the SCRIPT
    const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);
    
    // Match "./something" or './something' patterns (relative to script directory)
    js = js.replace(/["'`](\.\/[^"'`\s]+)["'`]/g, (match, relUrl) => {
        const quote = match[0];
        // Build absolute URL from script's directory
        const absoluteUrl = base.origin + basePath + relUrl.substring(2); // Remove "./"
        try {
            const targetUrl = new URL(absoluteUrl);
            const proxiedUrl = `${proxyOrigin}${targetUrl.pathname}?__cpo=${encodeUrl(absoluteUrl)}`;
            console.log(`[PROXY-JS] Rewrote relative URL: ${relUrl} -> ${absoluteUrl}`);
            return `${quote}${proxiedUrl}${quote}`;
        } catch { return match; }
    });
    
    // Also handle "../something" patterns (parent directory relative)
    js = js.replace(/["'`](\.\.\/[^"'`\s]+)["'`]/g, (match, relUrl) => {
        const quote = match[0];
        try {
            // Use URL constructor to resolve the relative path
            const absoluteUrl = new URL(relUrl, baseUrl).href;
            const targetUrl = new URL(absoluteUrl);
            const proxiedUrl = `${proxyOrigin}${targetUrl.pathname}?__cpo=${encodeUrl(absoluteUrl)}`;
            console.log(`[PROXY-JS] Rewrote parent-relative URL: ${relUrl} -> ${absoluteUrl}`);
            return `${quote}${proxiedUrl}${quote}`;
        } catch (e) {
            return match; // Keep original if resolution fails
        }
    });
    
    return js;
}

/**
 * Main server
 */
const server = http.createServer(async (req, res) => {
    // Detect HTTPS from Cloudflare tunnel or other reverse proxies
    const protocol = (req.headers['x-forwarded-proto'] === 'https' || req.headers['cf-visitor']?.includes('https')) ? 'https' : 'http';
    const proxyOrigin = `${protocol}://${req.headers.host}`;
    
    console.log(`[${new Date().toISOString().split('T')[1].slice(0,8)}] ${req.method} ${req.url}`);
    
    // CORS headers - Must allow x-csrf-token for Roblox!
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, x-csrf-token, Cookie, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Expose-Headers', 'x-csrf-token, Set-Cookie');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    // ========== HOMEPAGE ==========
    if (req.url === '/' || req.url === '') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Nebula — Web Proxy</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg fill='%239333ea' height='32' width='32' viewBox='0 0 458.758 458.758' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M448.189,10.579c-11.9-11.9-30.2-13.8-54.3-5.5c-10.6,3.6-22.6,9.2-36.1,16.8c-8.1,4.6-16.8,9.8-25.8,15.8c-2.4,1.6-4.8,3.2-7.3,4.9c13.8,7,26.7,15.5,38.6,25.5c2.8-1.7,5.4-3.4,8-4.9c22.8-13.6,37.1-18.8,44.6-20.3c-2,10.1-10.7,32.8-37.9,72c-2.2,3.1-4.4,6.3-6.7,9.5c-5.1-6.9-10.8-13.6-17.1-19.8c-68.9-68.9-180.7-68.9-249.6,0s-68.9,180.7,0,249.6c6.3,6.3,12.9,12,19.8,17.1c-3.2,2.3-6.4,4.5-9.5,6.7c-39.2,27.1-61.9,35.9-72,37.9c1.2-6.1,4.9-17,13.8-33.4c3.1-5.7,6.8-12.1,11.3-19.2c-9.9-11.9-18.4-24.8-25.5-38.6c-1.7,2.4-3.3,4.9-4.9,7.3c-8.3,12.6-15.2,24.3-20.7,35c-5.1,9.8-9,18.8-11.8,26.9c-8.2,24.1-6.4,42.4,5.5,54.3s30.2,13.8,54.3,5.5c17-5.8,37.8-16.8,61.9-32.6c47.6-31.3,104.4-79,159.8-134.4s103.2-112.2,134.4-159.8c15.8-24.1,26.8-44.9,32.6-61.9C461.889,40.779,460.089,22.579,448.189,10.579z'/%3E%3C/svg%3E">
    <style>
        :root{--bg1:#05010d;--bg2:#1a0a2e;--purple:#9333ea;--purple2:#a855f7;--purple3:#c084fc;--violet:#7c3aed;--magenta:#d946ef;--text:#f3e8ff;--muted:#c4b5fd;--glow:rgba(147,51,234,0.4)}
        *{box-sizing:border-box;margin:0;padding:0;font-family:'Inter',system-ui,-apple-system,sans-serif}
        body{min-height:100vh;color:var(--text);overflow-x:hidden;background:var(--bg1);background-image:radial-gradient(ellipse 1200px 800px at 15% 0%,rgba(147,51,234,0.15),transparent 50%),radial-gradient(ellipse 1000px 600px at 85% 20%,rgba(124,58,237,0.12),transparent 50%),radial-gradient(ellipse 800px 800px at 50% 100%,rgba(217,70,239,0.08),transparent 50%),linear-gradient(180deg,var(--bg2) 0%,var(--bg1) 40%,#000 100%);display:flex;align-items:center;justify-content:center;padding:20px}
        .stars{position:fixed;inset:0;background-image:radial-gradient(2px 2px at 20px 30px,rgba(255,255,255,0.3),transparent),radial-gradient(2px 2px at 40px 70px,rgba(255,255,255,0.2),transparent),radial-gradient(1px 1px at 90px 40px,rgba(255,255,255,0.4),transparent),radial-gradient(2px 2px at 130px 80px,rgba(255,255,255,0.2),transparent),radial-gradient(1px 1px at 160px 120px,rgba(255,255,255,0.5),transparent),radial-gradient(2px 2px at 200px 50px,rgba(200,180,255,0.3),transparent);background-size:350px 200px;animation:twinkle 8s ease-in-out infinite;opacity:0.6}
        @keyframes twinkle{0%,100%{opacity:0.6}50%{opacity:0.4}}
        .nebula{position:fixed;width:900px;height:900px;background:radial-gradient(circle,var(--glow),transparent 60%);filter:blur(120px);border-radius:999px;animation:drift 25s ease-in-out infinite;pointer-events:none}
        .nebula.n1{left:-20%;top:-10%;background:radial-gradient(circle,rgba(147,51,234,0.25),transparent 60%)}
        .nebula.n2{right:-15%;top:20%;width:700px;height:700px;background:radial-gradient(circle,rgba(124,58,237,0.2),transparent 60%);animation-delay:-8s;animation-duration:30s}
        @keyframes drift{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(30px,-40px) scale(1.05)}66%{transform:translate(-20px,30px) scale(0.95)}}
        .rings{position:fixed;inset:0;pointer-events:none;overflow:hidden}
        .ring{position:absolute;border:1px solid rgba(147,51,234,0.1);border-radius:50%;animation:orbit 60s linear infinite}
        .ring:nth-child(1){width:150vmax;height:150vmax;left:50%;top:50%;transform:translate(-50%,-50%)}
        .ring:nth-child(2){width:120vmax;height:120vmax;left:50%;top:50%;transform:translate(-50%,-50%);animation-duration:80s;animation-direction:reverse;border-color:rgba(124,58,237,0.08)}
        @keyframes orbit{from{transform:translate(-50%,-50%) rotate(0deg)}to{transform:translate(-50%,-50%) rotate(360deg)}}
        .wrap{position:relative;z-index:2;width:min(780px,calc(100% - 24px));padding:50px 50px 40px;border-radius:28px;background:linear-gradient(135deg,rgba(26,10,46,0.9),rgba(5,1,13,0.95));backdrop-filter:blur(20px);border:1px solid rgba(147,51,234,0.2);box-shadow:0 0 0 1px rgba(147,51,234,0.1),0 50px 100px -20px rgba(0,0,0,0.8),0 0 80px -30px rgba(147,51,234,0.3),inset 0 1px 0 rgba(255,255,255,0.05);animation:emerge 1s cubic-bezier(0.16,1,0.3,1);text-align:center}
        @keyframes emerge{from{opacity:0;transform:translateY(30px) scale(0.96)}to{opacity:1;transform:translateY(0) scale(1)}}
        .wrap::before{content:'';position:absolute;inset:0;border-radius:28px;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(147,51,234,0.03) 2px,rgba(147,51,234,0.03) 4px);pointer-events:none;opacity:0.5}
        .logo{width:70px;height:70px;margin:0 auto 16px;filter:drop-shadow(0 0 20px rgba(147,51,234,0.5));animation:float 6s ease-in-out infinite}
        .logo svg{width:100%;height:100%}
        @keyframes float{0%,100%{transform:translateY(0) rotate(0deg)}50%{transform:translateY(-8px) rotate(3deg)}}
        .title{font-size:3.5rem;font-weight:900;letter-spacing:2px;background:linear-gradient(135deg,#f3e8ff 0%,#c084fc 40%,#9333ea 70%,#7c3aed 100%);-webkit-background-clip:text;background-clip:text;color:transparent;text-transform:uppercase}
        .tagline{margin-top:8px;color:var(--muted);font-size:1rem}
        .badge{display:inline-flex;gap:10px;align-items:center;margin:24px auto 20px;padding:12px 20px;border-radius:999px;background:linear-gradient(135deg,rgba(147,51,234,0.2),rgba(124,58,237,0.15));border:1px solid rgba(147,51,234,0.3);color:var(--purple3);font-size:0.85rem;font-weight:500}
        .orb{width:10px;height:10px;border-radius:999px;background:linear-gradient(135deg,var(--purple2),var(--magenta));box-shadow:0 0 20px var(--purple),0 0 40px rgba(147,51,234,0.5);animation:pulse 2s ease-in-out infinite}
        @keyframes pulse{0%,100%{transform:scale(1);opacity:0.9}50%{transform:scale(1.3);opacity:1;box-shadow:0 0 30px var(--purple),0 0 60px rgba(147,51,234,0.4)}}
        .search-box{margin:32px 0 24px;display:flex;gap:12px}
        .search-input{flex:1;padding:18px 24px;font-size:1rem;background:rgba(0,0,0,0.4);border:2px solid rgba(147,51,234,0.3);border-radius:16px;color:var(--text);outline:none;transition:all 0.3s}
        .search-input::placeholder{color:var(--muted);opacity:0.6}
        .search-input:focus{border-color:var(--purple);box-shadow:0 0 0 4px rgba(147,51,234,0.2),0 0 30px -10px var(--purple)}
        .search-btn{padding:18px 32px;font-size:1rem;font-weight:600;background:linear-gradient(135deg,var(--purple),var(--violet));border:none;border-radius:16px;color:white;cursor:pointer;transition:all 0.3s;display:flex;align-items:center;gap:8px}
        .search-btn:hover{transform:translateY(-2px);box-shadow:0 10px 40px -10px var(--purple)}
        .quick-title{color:var(--muted);font-size:0.75rem;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:14px;opacity:0.7}
        .quick-links{display:flex;flex-wrap:wrap;gap:10px;justify-content:center}
        .quick-link{padding:12px 18px;background:rgba(147,51,234,0.1);border:1px solid rgba(147,51,234,0.2);border-radius:12px;color:var(--purple3);font-size:0.9rem;cursor:pointer;transition:all 0.2s;text-decoration:none}
        .quick-link:hover{background:var(--purple);border-color:var(--purple);color:white;transform:translateY(-2px);box-shadow:0 10px 30px -10px rgba(147,51,234,0.5)}
        footer{margin-top:28px;color:rgba(196,181,253,0.4);font-size:0.8rem}
        @media(max-width:600px){.wrap{padding:32px 20px}.title{font-size:2.4rem}.search-box{flex-direction:column}}
    </style>
</head>
<body>
    <div class="stars"></div>
    <div class="nebula n1"></div>
    <div class="nebula n2"></div>
    <div class="rings"><div class="ring"></div><div class="ring"></div></div>

    <main class="wrap">
        <div class="logo">
            <svg fill="#9333ea" viewBox="0 0 458.758 458.758" xmlns="http://www.w3.org/2000/svg">
                <path d="M448.189,10.579c-11.9-11.9-30.2-13.8-54.3-5.5c-10.6,3.6-22.6,9.2-36.1,16.8c-8.1,4.6-16.8,9.8-25.8,15.8c-2.4,1.6-4.8,3.2-7.3,4.9c13.8,7,26.7,15.5,38.6,25.5c2.8-1.7,5.4-3.4,8-4.9c22.8-13.6,37.1-18.8,44.6-20.3c-2,10.1-10.7,32.8-37.9,72c-2.2,3.1-4.4,6.3-6.7,9.5c-5.1-6.9-10.8-13.6-17.1-19.8c-68.9-68.9-180.7-68.9-249.6,0s-68.9,180.7,0,249.6c6.3,6.3,12.9,12,19.8,17.1c-3.2,2.3-6.4,4.5-9.5,6.7c-39.2,27.1-61.9,35.9-72,37.9c1.2-6.1,4.9-17,13.8-33.4c3.1-5.7,6.8-12.1,11.3-19.2c-9.9-11.9-18.4-24.8-25.5-38.6c-1.7,2.4-3.3,4.9-4.9,7.3c-8.3,12.6-15.2,24.3-20.7,35c-5.1,9.8-9,18.8-11.8,26.9c-8.2,24.1-6.4,42.4,5.5,54.3s30.2,13.8,54.3,5.5c17-5.8,37.8-16.8,61.9-32.6c47.6-31.3,104.4-79,159.8-134.4s103.2-112.2,134.4-159.8c15.8-24.1,26.8-44.9,32.6-61.9C461.889,40.779,460.089,22.579,448.189,10.579z M103.889,246.179c-9.3,0-16.8-7.5-16.8-16.8c0-38.2,14.9-74.2,41.9-101.2c6.6-6.6,17.2-6.6,23.8,0c6.6,6.6,6.6,17.2,0,23.8c-20.7,20.7-32.1,48.2-32.1,77.4C120.789,238.679,113.189,246.179,103.889,246.179z"/>
                <path d="M310.189,310.179c-35,35-70.6,67-104.3,94.1c52.6,7,107.9-9.7,148.3-50.1c40.5-40.5,57.2-95.7,50.1-148.3C377.189,239.579,345.189,275.179,310.189,310.179z"/>
            </svg>
        </div>
        
        <div class="title">Nebula</div>
        <div class="tagline">Journey beyond the boundaries of the web</div>

        <div class="badge">
            <span class="orb"></span>
            Encrypted Proxy • Anonymous Browsing • Zero Limits
        </div>

        <form class="search-box" id="proxyForm">
            <input type="text" class="search-input" id="urlInput" placeholder="Enter any URL — google.com, youtube.com..." required autofocus>
            <button type="submit" class="search-btn">
                <span>Browse</span>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </button>
        </form>

        <div class="quick-title">Quick Access</div>
        <div class="quick-links">
            <a href="/?__cpo=${encodeUrl('https://www.google.com')}" class="quick-link">🔍 Google</a>
            <a href="/?__cpo=${encodeUrl('https://www.youtube.com')}" class="quick-link">📺 YouTube</a>
            <a href="/?__cpo=${encodeUrl('https://now.gg')}" class="quick-link">🎮 Now.gg</a>
            <a href="/?__cpo=${encodeUrl('https://www.tiktok.com')}" class="quick-link">🎵 TikTok</a>
            <a href="/?__cpo=${encodeUrl('https://www.roblox.com')}" class="quick-link">🎮 Roblox</a>
            <a href="/?__cpo=${encodeUrl('https://www.reddit.com')}" class="quick-link">🔶 Reddit</a>
            <a href="/?__cpo=${encodeUrl('https://www.wikipedia.org')}" class="quick-link">📚 Wikipedia</a>
        </div>

        <footer>© 2026 Nebula</footer>
    </main>

    <script>
        document.getElementById('proxyForm').addEventListener('submit', function(e) {
            e.preventDefault();
            var url = document.getElementById('urlInput').value.trim();
            if (!url.startsWith('http')) url = 'https://' + url;
            try {
                var targetUrl = new URL(url);
                var encoded = btoa(url).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
                window.location.href = targetUrl.pathname + '?__cpo=' + encoded;
            } catch(e) {
                var encoded = btoa(url).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
                window.location.href = '/?__cpo=' + encoded;
            }
        });
    </script>
</body>
</html>
        `);
        return;
    }
    
    // ========== PROXY REQUEST (CroxyProxy-style: any URL with __cpo parameter) ==========
    // Check for __cpo parameter in URL (CroxyProxy format)
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const cpoParam = urlObj.searchParams.get('__cpo');
    
    if (cpoParam) {
        // CroxyProxy-style request: /path?__cpo=BASE64
        let targetUrl = decodeUrl(cpoParam);
        
        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid __cpo encoding: ' + cpoParam.substring(0, 50));
            return;
        }
        
        // Check if decoded URL is localhost - TikTok sometimes constructs these!
        // If so, extract the path and resolve it against the real site
        if (targetUrl && (targetUrl.includes('localhost:') || targetUrl.includes('127.0.0.1:'))) {
            console.log(`[PROXY] Detected localhost URL in base64: ${targetUrl}`);
            try {
                const localUrl = new URL(targetUrl);
                const localPath = localUrl.pathname + localUrl.search;
                
                // Get the real base URL from referer
                const referer = req.headers['referer'] || '';
                const refererMatch = referer.match(/__cpo=([A-Za-z0-9+/=_-]+)/);
                
                if (refererMatch) {
                    const refererBase = decodeUrl(refererMatch[1]);
                    if (refererBase && !refererBase.includes('localhost')) {
                        const realBase = new URL(refererBase);
                        targetUrl = realBase.origin + localPath;
                        console.log(`[PROXY] Resolved localhost URL to real: ${targetUrl}`);
                    }
                }
                
                // Fallback to session
                if (targetUrl.includes('localhost')) {
                    const clientId = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'default';
                    const sessionBase = sessionBaseUrls.get(clientId);
                    if (sessionBase && !sessionBase.includes('localhost')) {
                        const realBase = new URL(sessionBase);
                        targetUrl = realBase.origin + localPath;
                        console.log(`[PROXY] Resolved localhost URL from session: ${targetUrl}`);
                    }
                }
            } catch (e) {
                console.error('[PROXY] Failed to resolve localhost URL:', e.message);
            }
        }
        
        // Store this base URL for relative URL resolution
        const clientId = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'default';
        sessionBaseUrls.set(clientId, targetUrl);
        
        console.log(`[PROXY] ${req.method} ${targetUrl}`);
        
        // Collect request body for POST/PUT/PATCH
        let requestBody = null;
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            requestBody = await new Promise((resolve) => {
                const chunks = [];
                req.on('data', chunk => chunks.push(chunk));
                req.on('end', () => resolve(Buffer.concat(chunks)));
            });
        }
        
        try {
            // Extract important headers from client request
            const forwardHeaders = {
                'Content-Type': req.headers['content-type'] || 'application/json',
                'Accept': req.headers['accept'] || '*/*',
            };
            
            // Forward x-csrf-token if client sent it
            const csrfToken = req.headers['x-csrf-token'];
            
            // Forward cookies if present
            const cookies = req.headers['cookie'];
            
            const response = await fetchUrl(targetUrl, {
                method: req.method,
                referer: targetUrl,
                body: requestBody,
                csrfToken: csrfToken,
                cookies: cookies,
                headers: forwardHeaders
            });
            
            // If response is undefined or missing data, return error
            if (!response || !response.data) {
                throw new Error('Empty response from server');
            }
            
            const contentType = response.headers['content-type'] || 'application/octet-stream';
            const isHtml = contentType.includes('text/html');
            const isCss = contentType.includes('text/css');
            const isJs = contentType.includes('javascript');
            
            let body = response.data;
            
            // Rewrite based on content type
            try {
                if (isHtml) {
                    body = rewriteUrls(body, targetUrl, proxyOrigin);
                } else if (isCss) {
                    body = rewriteCss(body, targetUrl, proxyOrigin);
                } else if (isJs) {
                    body = rewriteJs(body, targetUrl, proxyOrigin);
                }
            } catch (rewriteError) {
                console.error(`[REWRITE ERROR] ${rewriteError.message}`);
                // Return original content if rewriting fails
            }
            
            // Build response headers - strip security headers that block captcha!
            const headers = {
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Credentials': 'true',
                // NOTE: We intentionally DO NOT forward these headers:
                // - Content-Security-Policy (blocks captcha scripts)
                // - X-Frame-Options (blocks iframes)
                // - X-Content-Type-Options (can cause issues)
                // This is necessary for FunCaptcha/Arkose Labs to work!
                'Access-Control-Expose-Headers': 'x-csrf-token, set-cookie, rblx-challenge-id, rblx-challenge-type, rblx-challenge-metadata',
            };
            
            // Forward CSRF token back to client (critical for Roblox!)
            if (response.headers['x-csrf-token']) {
                headers['x-csrf-token'] = response.headers['x-csrf-token'];
            }
            
            // CRITICAL: Forward Roblox challenge headers for captcha!
            if (response.headers['rblx-challenge-id']) {
                headers['rblx-challenge-id'] = response.headers['rblx-challenge-id'];
                console.log('[PROXY] Forwarding challenge-id:', response.headers['rblx-challenge-id']);
            }
            if (response.headers['rblx-challenge-type']) {
                headers['rblx-challenge-type'] = response.headers['rblx-challenge-type'];
                console.log('[PROXY] Forwarding challenge-type:', response.headers['rblx-challenge-type']);
            }
            if (response.headers['rblx-challenge-metadata']) {
                headers['rblx-challenge-metadata'] = response.headers['rblx-challenge-metadata'];
                console.log('[PROXY] Forwarding challenge-metadata');
            }
            
            // Forward set-cookie headers
            if (response.headers['set-cookie']) {
                // Modify cookies to work with proxy domain
                const cookies = Array.isArray(response.headers['set-cookie']) 
                    ? response.headers['set-cookie'] 
                    : [response.headers['set-cookie']];
                headers['Set-Cookie'] = cookies.map(c => 
                    c.replace(/Domain=[^;]+;?/gi, '').replace(/Secure;?/gi, '').replace(/SameSite=[^;]+;?/gi, 'SameSite=Lax;')
                );
            }
            
            // Copy some useful headers
            if (response.headers['content-disposition']) {
                headers['Content-Disposition'] = response.headers['content-disposition'];
            }
            if (response.headers['cache-control']) {
                headers['Cache-Control'] = response.headers['cache-control'];
            }
            
            res.writeHead(response.statusCode || 200, headers);
            res.end(body);
            
        } catch (e) {
            console.error(`[ERROR] ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(`
                <html>
                <head><title>Proxy Error</title></head>
                <body style="font-family: sans-serif; padding: 40px; text-align: center; background: #1a1a2e; color: #fff;">
                    <h1>⚠️ Proxy Error</h1>
                    <p style="color: #ff6b6b;">${e.message}</p>
                    <p>URL: ${targetUrl}</p>
                    <a href="/" style="color: #6366f1;">← Back to home</a>
                </body>
                </html>
            `);
        }
        return;
    }
    
    // 404 for everything else - BUT check if it's a relative URL from a proxied page
    // This handles requests like /oapi/... or /styles.css that didn't get rewritten
    const referer = req.headers.referer;
    const clientId = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'default';
    
    // Try to get base URL from referer or session
    let baseUrl = null;
    
    if (referer && referer.includes('__cpo=')) {
        // Extract the base URL from referer
        const refMatch = referer.match(/[?&]__cpo=([A-Za-z0-9_-]+)/);
        if (refMatch) {
            baseUrl = decodeUrl(refMatch[1]);
        }
    }
    
    // Fallback to session-stored base URL
    if (!baseUrl && sessionBaseUrls.has(clientId)) {
        baseUrl = sessionBaseUrls.get(clientId);
    }
    
    if (baseUrl) {
        try {
            const base = new URL(baseUrl);
            
            // CRITICAL: Don't resolve if base URL is localhost (prevents infinite loop!)
            if (base.hostname === 'localhost' || base.hostname === '127.0.0.1') {
                console.log(`[RELATIVE] Skipping localhost base URL: ${baseUrl}`);
                // Fall through to 404
            } else {
                const fullUrl = new URL(req.url, base.origin).href;
                
                console.log(`[RELATIVE] ${req.method} ${req.url} -> ${fullUrl}`);
                
                // Collect request body for POST/PUT/PATCH
                let requestBody = null;
                if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
                    requestBody = await new Promise((resolve) => {
                        const chunks = [];
                        req.on('data', chunk => chunks.push(chunk));
                        req.on('end', () => resolve(Buffer.concat(chunks)));
                    });
                }
                
                const response = await fetchUrl(fullUrl, { 
                    method: req.method,
                    referer: baseUrl,
                    body: requestBody,
                    csrfToken: req.headers['x-csrf-token'],
                    cookies: req.headers['cookie'],
                    headers: {
                        'Content-Type': req.headers['content-type'] || 'application/json',
                        'Accept': req.headers['accept'] || '*/*',
                    }
                });
                
                // Check if response is valid
                if (!response || !response.data) {
                    throw new Error('Empty response');
                }
                
                const contentType = response.headers['content-type'] || 'application/octet-stream';
                const isHtml = contentType.includes('text/html');
                const isCss = contentType.includes('text/css');
                
                let body = response.data;
                
                try {
                    if (isHtml) {
                        body = rewriteUrls(body, fullUrl, proxyOrigin);
                    } else if (isCss) {
                        body = rewriteCss(body, fullUrl, proxyOrigin);
                    }
                } catch (rewriteErr) {
                    console.error(`[REWRITE ERROR] ${rewriteErr.message}`);
                }
                
                const resHeaders = {
                    'Content-Type': contentType,
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Expose-Headers': 'x-csrf-token',
                    'Cache-Control': response.headers['cache-control'] || 'public, max-age=3600',
                };
                // Forward CSRF token for Roblox
                if (response.headers['x-csrf-token']) {
                    resHeaders['x-csrf-token'] = response.headers['x-csrf-token'];
                }
                res.writeHead(response.statusCode || 200, resHeaders);
                res.end(body);
                return;
            }
        } catch (e) {
            console.error(`[RELATIVE ERROR] ${req.url}: ${e.message}`);
            // Don't return here - fall through to 404
        }
    }
    
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found: ' + req.url);
});

server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                                                                   ║
║   🌐 SERVER-SIDE URL REWRITING PROXY                              ║
║                                                                   ║
║   Local:  http://localhost:${PORT}                                  ║
║                                                                   ║
║   ✓ Works like CroxyProxy (NOT Ultraviolet!)                      ║
║   ✓ Server fetches & rewrites ALL URLs                            ║
║   ✓ Client renders native HTML (fast on iPads!)                   ║
║   ✓ Works through Cloudflare Tunnel                               ║
║   ✓ Supports: now.gg, YouTube, TikTok, Roblox, etc.               ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
    `);
});
