/**
 * TikTok Proxy Client Patches
 * 
 * This script runs BEFORE any TikTok code executes.
 * It patches browser APIs to make TikTok think it's running on tiktok.com.
 * 
 * CRITICAL: These patches must be bulletproof. TikTok checks these constantly.
 * 
 * What we patch:
 * - window.location / document.location (via global proxy)
 * - document.domain
 * - document.referrer
 * - window.origin
 * - History API (pushState, replaceState)
 * - window.postMessage
 * - WebSocket constructor
 * - document.cookie (domain translation)
 * - XMLHttpRequest
 * - fetch (as backup to SW)
 */

(function() {
    'use strict';

    // Don't run if already patched
    if (window.__TIKTOK_PROXY_PATCHED__) return;
    window.__TIKTOK_PROXY_PATCHED__ = true;

    const config = window.__PROXY_CONFIG__ || {
        proxyOrigin: window.location.origin,
        targetOrigin: 'https://www.tiktok.com',
        targetHostname: 'www.tiktok.com'
    };

    const PROXY_ORIGIN = config.proxyOrigin;
    const TARGET_ORIGIN = config.targetOrigin;
    const TARGET_HOSTNAME = config.targetHostname;
    const PROXY_HOSTNAME = new URL(PROXY_ORIGIN).hostname;
    
    // Store real location before any patches
    const REAL_LOCATION = window.location;
    const REAL_PATHNAME = window.location.pathname;
    const REAL_SEARCH = window.location.search;
    const REAL_HASH = window.location.hash;

    console.log('[TikTok Proxy] Initializing client patches');
    console.log('[TikTok Proxy] Proxy origin:', PROXY_ORIGIN);
    console.log('[TikTok Proxy] Target origin:', TARGET_ORIGIN);

    // ============================================================
    // CREATE FAKE LOCATION OBJECT
    // This object will be returned when code accesses 'location'
    // ============================================================

    const fakeLocation = {
        get hostname() { return TARGET_HOSTNAME; },
        get host() { return TARGET_HOSTNAME; },
        get origin() { return TARGET_ORIGIN; },
        get protocol() { return 'https:'; },
        get port() { return ''; },
        get pathname() { return REAL_LOCATION.pathname; },
        get search() { return REAL_LOCATION.search; },
        get hash() { return REAL_LOCATION.hash; },
        get href() { 
            return TARGET_ORIGIN + REAL_LOCATION.pathname + REAL_LOCATION.search + REAL_LOCATION.hash; 
        },
        set href(value) {
            const strValue = String(value);
            if (strValue.includes('tiktok.com')) {
                try {
                    const url = new URL(strValue);
                    REAL_LOCATION.href = PROXY_ORIGIN + url.pathname + url.search + url.hash;
                } catch (e) {
                    REAL_LOCATION.href = strValue;
                }
            } else {
                REAL_LOCATION.href = strValue;
            }
        },
        assign: function(url) {
            this.href = url;
        },
        replace: function(url) {
            const strUrl = String(url);
            if (strUrl.includes('tiktok.com')) {
                try {
                    const parsed = new URL(strUrl);
                    REAL_LOCATION.replace(PROXY_ORIGIN + parsed.pathname + parsed.search + parsed.hash);
                } catch (e) {
                    REAL_LOCATION.replace(strUrl);
                }
            } else {
                REAL_LOCATION.replace(strUrl);
            }
        },
        reload: function(force) {
            REAL_LOCATION.reload(force);
        },
        toString: function() {
            return this.href;
        },
        valueOf: function() {
            return this.href;
        }
    };

    // Make it look like a Location object
    Object.setPrototypeOf(fakeLocation, Location.prototype);

    // ============================================================
    // CRITICAL: Define __proxyLocation for rewritten JavaScript
    // Server rewrites document.location -> document.__proxyLocation
    // so we need to define __proxyLocation to return fakeLocation
    // ============================================================

    // Define __proxyLocation on window
    try {
        Object.defineProperty(window, '__proxyLocation', {
            get: () => fakeLocation,
            set: (val) => { fakeLocation.href = val; },
            configurable: true
        });
    } catch (e) {}

    // Define __proxyLocation on document
    try {
        Object.defineProperty(document, '__proxyLocation', {
            get: () => fakeLocation,
            set: (val) => { fakeLocation.href = val; },
            configurable: true
        });
    } catch (e) {}

    // Also define on Object.prototype (catches all objects like UV does)
    try {
        Object.defineProperty(Object.prototype, '__proxyLocation', {
            get: function() {
                if (this === window || this === document || this === self || this === globalThis) {
                    return fakeLocation;
                }
                // For other objects, return their real location if they have one
                return this.location;
            },
            set: function(val) {
                if (this === window || this === document) {
                    fakeLocation.href = val;
                } else {
                    this.location = val;
                }
            },
            configurable: true
        });
    } catch (e) {}

    // Global __proxyLocation variable (for bare 'location' that got rewritten to '__proxyLocation')
    window.__proxyLocation = fakeLocation;
    
    console.log('[TikTok Proxy] __proxyLocation defined for rewritten JS');

    // ============================================================
    // GLOBAL VARIABLE INTERCEPTION
    // Patch how scripts access 'location' globally
    // ============================================================

    // Create a proxy for the window object to intercept 'location' access
    const windowProxy = new Proxy(window, {
        get: function(target, prop) {
            if (prop === 'location') {
                return fakeLocation;
            }
            const value = target[prop];
            if (typeof value === 'function') {
                return value.bind(target);
            }
            return value;
        },
        set: function(target, prop, value) {
            if (prop === 'location') {
                fakeLocation.href = value;
                return true;
            }
            target[prop] = value;
            return true;
        }
    });

    // Override self to return our proxy
    try {
        Object.defineProperty(window, 'self', {
            get: () => windowProxy,
            configurable: true
        });
    } catch (e) {
        console.warn('[TikTok Proxy] Could not patch self:', e.message);
    }

    // Patch globalThis
    try {
        Object.defineProperty(window, 'globalThis', {
            get: () => windowProxy,
            configurable: true
        });
    } catch (e) {}

    console.log('[TikTok Proxy] Window proxy created');

    // ============================================================
    // STRING PROTOTYPE PATCHES
    // Intercept string checks that compare against hostname
    // ============================================================

    const originalIncludes = String.prototype.includes;
    String.prototype.includes = function(searchString, position) {
        // If checking for proxy hostname, pretend it's tiktok
        if (searchString === PROXY_HOSTNAME || searchString === 'trycloudflare') {
            if (this.valueOf().includes('tiktok')) {
                return originalIncludes.call(this, searchString, position);
            }
        }
        return originalIncludes.call(this, searchString, position);
    };

    const originalIndexOf = String.prototype.indexOf;
    String.prototype.indexOf = function(searchString, position) {
        return originalIndexOf.call(this, searchString, position);
    };

    console.log('[TikTok Proxy] String patches applied');

    // ============================================================
    // DOCUMENT PATCHES
    // ============================================================

    // Patch document.domain
    try {
        Object.defineProperty(document, 'domain', {
            get: () => 'tiktok.com',
            set: () => {}, // Ignore attempts to set
            configurable: false
        });
    } catch (e) {
        console.warn('[TikTok Proxy] Could not patch document.domain:', e.message);
    }

    // Patch document.referrer
    try {
        Object.defineProperty(document, 'referrer', {
            get: () => 'https://www.tiktok.com/',
            configurable: false
        });
    } catch (e) {
        console.warn('[TikTok Proxy] Could not patch document.referrer:', e.message);
    }

    // Patch document.URL
    try {
        Object.defineProperty(document, 'URL', {
            get: () => TARGET_ORIGIN + REAL_LOCATION.pathname + REAL_LOCATION.search,
            configurable: false
        });
    } catch (e) {
        console.warn('[TikTok Proxy] Could not patch document.URL:', e.message);
    }

    // Patch document.documentURI
    try {
        Object.defineProperty(document, 'documentURI', {
            get: () => TARGET_ORIGIN + REAL_LOCATION.pathname + REAL_LOCATION.search,
            configurable: false
        });
    } catch (e) {}

    // Patch document.location to return our fake
    try {
        Object.defineProperty(document, 'location', {
            get: () => fakeLocation,
            set: (value) => { fakeLocation.href = value; },
            configurable: true
        });
        console.log('[TikTok Proxy] document.location patched');
    } catch (e) {
        console.warn('[TikTok Proxy] Could not patch document.location:', e.message);
    }

    // ============================================================
    // WINDOW PATCHES
    // ============================================================

    // Patch window.origin
    try {
        Object.defineProperty(window, 'origin', {
            get: () => TARGET_ORIGIN,
            configurable: false
        });
    } catch (e) {
        console.warn('[TikTok Proxy] Could not patch window.origin:', e.message);
    }

    // ============================================================
    // HISTORY API PATCHES
    // ============================================================

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function(state, title, url) {
        if (url) {
            try {
                const parsed = new URL(url, TARGET_ORIGIN);
                if (parsed.origin === TARGET_ORIGIN) {
                    // Keep only the path for our proxy
                    url = parsed.pathname + parsed.search + parsed.hash;
                }
            } catch (e) {
                // If URL parsing fails, use as-is
            }
        }
        return originalPushState.call(this, state, title, url);
    };

    history.replaceState = function(state, title, url) {
        if (url) {
            try {
                const parsed = new URL(url, TARGET_ORIGIN);
                if (parsed.origin === TARGET_ORIGIN) {
                    url = parsed.pathname + parsed.search + parsed.hash;
                }
            } catch (e) {}
        }
        return originalReplaceState.call(this, state, title, url);
    };

    // ============================================================
    // POSTMESSAGE PATCH
    // ============================================================

    const originalPostMessage = window.postMessage;

    window.postMessage = function(message, targetOrigin, transfer) {
        // If targeting TikTok origin, redirect to our proxy origin
        if (targetOrigin === TARGET_ORIGIN || targetOrigin === 'https://tiktok.com') {
            targetOrigin = PROXY_ORIGIN;
        }
        // If targeting wildcard or self, allow
        if (targetOrigin === '*' || targetOrigin === PROXY_ORIGIN) {
            return originalPostMessage.call(this, message, targetOrigin, transfer);
        }
        // For other origins, try to allow
        return originalPostMessage.call(this, message, targetOrigin, transfer);
    };

    // Patch incoming message events to spoof origin
    window.addEventListener('message', function(event) {
        if (event.origin === PROXY_ORIGIN) {
            // Make it look like it came from TikTok
            try {
                Object.defineProperty(event, 'origin', {
                    get: () => TARGET_ORIGIN,
                    configurable: true
                });
            } catch (e) {}
        }
    }, true);

    // ============================================================
    // WEBSOCKET PATCH
    // ============================================================

    const OriginalWebSocket = window.WebSocket;

    window.WebSocket = function(url, protocols) {
        let targetUrl = url;
        
        // If it's a TikTok WebSocket, route through our proxy
        try {
            const parsed = new URL(url);
            if (parsed.hostname.includes('tiktok') || parsed.hostname.includes('ttwstatic')) {
                // Encode and route through our WS proxy
                const encoded = btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
                const proxyWsUrl = PROXY_ORIGIN.replace('http://', 'ws://').replace('https://', 'wss://');
                targetUrl = proxyWsUrl + '/ws/' + encoded;
                console.log('[TikTok Proxy] WebSocket redirected:', url, '->', targetUrl);
            }
        } catch (e) {
            console.warn('[TikTok Proxy] WebSocket URL parse error:', e);
        }

        return new OriginalWebSocket(targetUrl, protocols);
    };

    // Copy static properties
    window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
    window.WebSocket.OPEN = OriginalWebSocket.OPEN;
    window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
    window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;
    window.WebSocket.prototype = OriginalWebSocket.prototype;

    // ============================================================
    // COOKIE PATCHES
    // ============================================================

    // TikTok sets cookies for .tiktok.com but we're on localhost.
    // We just strip the domain restriction and let cookies work naturally.
    // DO NOT prefix cookies - it breaks TikTok's base64 parsing!

    const originalCookieDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') ||
                                     Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');

    if (originalCookieDescriptor) {
        Object.defineProperty(document, 'cookie', {
            get: function() {
                // Return cookies as-is
                return originalCookieDescriptor.get.call(this);
            },
            set: function(value) {
                // Just remove domain restrictions, don't modify cookie names or values
                let newValue = value;
                
                // Remove domain restrictions so cookies work on our proxy domain
                newValue = newValue.replace(/;\s*domain=[^;]*/gi, '');
                
                // Remove secure flag if we're on http
                if (PROXY_ORIGIN.startsWith('http://')) {
                    newValue = newValue.replace(/;\s*secure/gi, '');
                }

                return originalCookieDescriptor.set.call(this, newValue);
            },
            configurable: true
        });
    }

    // ============================================================
    // FETCH BACKUP (in case Service Worker misses something)
    // ============================================================

    // Check if URL is a video CDN that should bypass proxy
    function isVideoCdn(urlStr) {
        try {
            const url = new URL(urlStr);
            const hostname = url.hostname.toLowerCase();
            const pathname = url.pathname.toLowerCase();
            
            // Video CDN patterns
            if (hostname.includes('v16-webapp') || hostname.includes('v19-webapp') ||
                hostname.includes('v58-webapp') || hostname.includes('v77-webapp') ||
                hostname.includes('webapp-prime') || hostname.includes('pull-')) {
                return true;
            }
            
            // Video file patterns
            if (pathname.includes('/video/') || pathname.endsWith('.mp4') || 
                pathname.endsWith('.webm') || url.search.includes('mime_type=video')) {
                return true;
            }
            
            return false;
        } catch {
            return false;
        }
    }

    const originalFetch = window.fetch;

    window.fetch = async function(input, init) {
        let url = input instanceof Request ? input.url : input;
        let originalTikTokUrl = null; // Store original URL for response spoofing
        
        try {
            const parsed = new URL(url, TARGET_ORIGIN);
            
            // SKIP video CDN - let it go direct to avoid 403s
            if (isVideoCdn(url)) {
                return originalFetch.call(this, input, init);
            }
            
            // If it's a TikTok URL not going through our proxy, rewrite it
            // Check ALL TikTok-related domains
            const isTikTokDomain = parsed.hostname.includes('tiktok') || 
                parsed.hostname.includes('ttwstatic') || 
                parsed.hostname.includes('bytedtos') || 
                parsed.hostname.includes('tiktokcdn') ||
                parsed.hostname.includes('tiktokv') ||
                parsed.hostname.includes('tiktokw') ||
                parsed.hostname.includes('byteimg') ||
                parsed.hostname.includes('musical.ly') ||
                parsed.hostname.includes('muscdn') ||
                parsed.hostname.includes('ibytedtos');
            
            if (isTikTokDomain) {
                if (!url.includes('/bare/')) {
                    originalTikTokUrl = url; // Save for response URL spoofing
                    const encoded = btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
                    url = PROXY_ORIGIN + '/bare/' + encoded;
                    
                    if (input instanceof Request) {
                        input = new Request(url, input);
                    } else {
                        input = url;
                    }
                }
            }
        } catch (e) {
            // URL parsing failed, use as-is
        }

        const response = await originalFetch.call(this, input, init);
        
        // CRITICAL: Spoof response.url to look like it came from TikTok
        // TikTok checks response.url and rejects if it's not tiktok.com
        if (originalTikTokUrl || response.url.includes(PROXY_ORIGIN)) {
            const spoofedUrl = originalTikTokUrl || response.url.replace(PROXY_ORIGIN, TARGET_ORIGIN);
            
            // Create a new Response with spoofed URL
            const spoofedResponse = new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
            });
            
            // Override the url property
            Object.defineProperty(spoofedResponse, 'url', {
                value: spoofedUrl,
                writable: false
            });
            
            return spoofedResponse;
        }
        
        return response;
    };

    // ============================================================
    // XMLHTTPREQUEST BACKUP
    // ============================================================

    const OriginalXHR = window.XMLHttpRequest;
    const originalOpen = OriginalXHR.prototype.open;

    OriginalXHR.prototype.open = function(method, url, ...args) {
        let targetUrl = url;

        try {
            const parsed = new URL(url, TARGET_ORIGIN);
            
            // SKIP video CDN - let it go direct
            if (isVideoCdn(url)) {
                return originalOpen.call(this, method, url, ...args);
            }
            
            // Check ALL TikTok-related domains
            const isTikTokDomain = parsed.hostname.includes('tiktok') || 
                parsed.hostname.includes('ttwstatic') ||
                parsed.hostname.includes('bytedtos') || 
                parsed.hostname.includes('tiktokcdn') ||
                parsed.hostname.includes('tiktokv') ||
                parsed.hostname.includes('tiktokw') ||
                parsed.hostname.includes('byteimg') ||
                parsed.hostname.includes('musical.ly') ||
                parsed.hostname.includes('muscdn') ||
                parsed.hostname.includes('ibytedtos');
            
            if (isTikTokDomain) {
                if (!url.includes('/bare/')) {
                    const encoded = btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
                    targetUrl = PROXY_ORIGIN + '/bare/' + encoded;
                }
            }
        } catch (e) {}

        return originalOpen.call(this, method, targetUrl, ...args);
    };

    // ============================================================
    // URL CONSTRUCTOR PATCH
    // ============================================================

    const OriginalURL = window.URL;

    window.URL = function(url, base) {
        // If base is our proxy but URL expects tiktok, adjust
        if (base && base.includes && base.includes(PROXY_ORIGIN)) {
            base = base.replace(PROXY_ORIGIN, TARGET_ORIGIN);
        }
        return new OriginalURL(url, base);
    };

    // Copy static methods
    window.URL.createObjectURL = OriginalURL.createObjectURL;
    window.URL.revokeObjectURL = OriginalURL.revokeObjectURL;
    window.URL.prototype = OriginalURL.prototype;

    // ============================================================
    // STORAGE PATCHES (localStorage, sessionStorage)
    // ============================================================

    // Storage is already domain-scoped, but TikTok might check the origin
    // We'll let storage work normally since we're on the same proxy domain

    // ============================================================
    // WORKER PATCHES
    // ============================================================

    // Patch Worker constructor to handle TikTok's workers
    const OriginalWorker = window.Worker;

    window.Worker = function(url, options) {
        let targetUrl = url;

        try {
            if (typeof url === 'string') {
                const parsed = new URL(url, TARGET_ORIGIN);
                if (parsed.hostname.includes('tiktok') || parsed.hostname.includes('ttwstatic')) {
                    const encoded = btoa(parsed.href).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
                    targetUrl = PROXY_ORIGIN + '/bare/' + encoded;
                }
            }
        } catch (e) {}

        return new OriginalWorker(targetUrl, options);
    };

    window.Worker.prototype = OriginalWorker.prototype;

    // ============================================================
    // IMAGE/SCRIPT/LINK CREATION PATCHES
    // ============================================================

    const originalCreateElement = document.createElement;

    document.createElement = function(tagName, options) {
        const element = originalCreateElement.call(this, tagName, options);
        const tag = tagName.toLowerCase();

        if (tag === 'script' || tag === 'img' || tag === 'link' || tag === 'video' || tag === 'source') {
            // Patch src/href setters to rewrite TikTok URLs
            const originalSrcDescriptor = Object.getOwnPropertyDescriptor(element.__proto__, 'src') ||
                                          Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'src');
            
            if (originalSrcDescriptor && originalSrcDescriptor.set) {
                Object.defineProperty(element, 'src', {
                    get: function() {
                        return originalSrcDescriptor.get ? originalSrcDescriptor.get.call(this) : this.getAttribute('src');
                    },
                    set: function(value) {
                        if (value && typeof value === 'string') {
                            try {
                                const parsed = new URL(value, TARGET_ORIGIN);
                                if (parsed.hostname.includes('tiktok') || parsed.hostname.includes('ttwstatic') ||
                                    parsed.hostname.includes('bytedtos') || parsed.hostname.includes('tiktokcdn')) {
                                    const encoded = btoa(parsed.href).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
                                    value = PROXY_ORIGIN + '/bare/' + encoded;
                                }
                            } catch (e) {}
                        }
                        if (originalSrcDescriptor.set) {
                            return originalSrcDescriptor.set.call(this, value);
                        }
                        return this.setAttribute('src', value);
                    },
                    configurable: true
                });
            }
        }

        return element;
    };

    // ============================================================
    // NAVIGATOR PATCHES (optional, for extra stealth)
    // ============================================================

    // TikTok might check these for bot detection
    // We leave them as-is since we're running in a real browser

    // ============================================================
    // PERFORMANCE TIMING PATCHES
    // ============================================================

    // TikTok uses performance timing for fingerprinting
    // We leave this alone - real browser timing is what we want

    // ============================================================
    // CONSOLE SUPPRESSION (optional)
    // ============================================================

    // Suppress common TikTok errors that are harmless
    const originalConsoleError = console.error;
    console.error = function(...args) {
        const msg = args[0]?.toString() || '';
        
        // Suppress known harmless errors
        if (msg.includes('ResizeObserver') || 
            msg.includes('Non-Error promise rejection') ||
            msg.includes('Loading chunk')) {
            return;
        }
        
        return originalConsoleError.apply(this, args);
    };

    // ============================================================
    // DONE
    // ============================================================

    console.log('[TikTok Proxy] Client patches applied successfully');
    // Test our fake location values
    console.log('[TikTok Proxy] fakeLocation.hostname:', fakeLocation.hostname);
    console.log('[TikTok Proxy] fakeLocation.origin:', fakeLocation.origin);
    console.log('[TikTok Proxy] document.location.hostname:', document.location?.hostname);
    console.log('[TikTok Proxy] window.origin:', window.origin);

})();
