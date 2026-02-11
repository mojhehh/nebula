/**
 * Runtime Script Injection
 * 
 * This script is injected into every HTML page to intercept
 * dynamic URL creation at runtime, ensuring all requests
 * continue to route through the proxy.
 * 
 * Strategy:
 * - Override fetch(), XMLHttpRequest, WebSocket
 * - Intercept dynamic imports
 * - Handle History API for navigation
 * - Intercept Element.setAttribute for dynamic URL attributes
 * - Handle document.write and innerHTML
 */

/**
 * Generate the runtime script content
 */
export function getRuntimeScript(proxyOrigin) {
  return `
(function() {
  'use strict';
  
  // Avoid double initialization
  if (window.__PROXY_RUNTIME_INITIALIZED__) return;
  window.__PROXY_RUNTIME_INITIALIZED__ = true;
  
  const PROXY_ORIGIN = ${JSON.stringify(proxyOrigin)};
  const PROXY_PREFIX = PROXY_ORIGIN + '/proxy/';
  
  // Utility: Base64url encode
  function base64urlEncode(str) {
    const base64 = btoa(unescape(encodeURIComponent(str)));
    return base64.replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  
  // Utility: Base64url decode
  function base64urlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return decodeURIComponent(escape(atob(str)));
  }
  
  // Utility: Check if URL is already proxied
  function isProxied(url) {
    if (!url || typeof url !== 'string') return false;
    // Check for proxy prefix
    if (url.startsWith(PROXY_PREFIX)) return true;
    // Check for relative proxy paths
    if (url.startsWith('/proxy/')) return true;
    return false;
  }
  
  // Utility: Check if URL should be skipped
  function shouldSkip(url) {
    if (!url || typeof url !== 'string') return true;
    if (url.startsWith('data:')) return true;
    if (url.startsWith('blob:')) return true;
    if (url.startsWith('javascript:')) return true;
    if (url.startsWith('about:')) return true;
    if (url.startsWith('mailto:')) return true;
    if (url.startsWith('#')) return true;
    return false;
  }
  
  // Utility: Get current target origin from URL
  function getCurrentTargetOrigin() {
    const path = location.pathname;
    if (!path.startsWith('/proxy/')) return null;
    
    const encoded = path.slice('/proxy/'.length);
    if (!encoded) return null;
    
    try {
      let decoded;
      // Check if URL-encoded (contains % or starts with http)
      if (encoded.includes('%') || encoded.startsWith('http')) {
        decoded = decodeURIComponent(encoded.split('/')[0].split('?')[0]);
      } else {
        // Base64url encoded
        const base64Part = encoded.match(/^([A-Za-z0-9_-]+)/)?.[1];
        if (base64Part) {
          decoded = base64urlDecode(base64Part);
        }
      }
      
      if (decoded) {
        const url = new URL(decoded);
        return url.origin;
      }
    } catch (e) {
      console.warn('[Proxy] Failed to get target origin:', e);
    }
    return null;
  }
  
  // Utility: Get current target URL
  function getCurrentTargetUrl() {
    const path = location.pathname + location.search + location.hash;
    if (!path.startsWith('/proxy/')) return location.href;
    
    const encoded = path.slice('/proxy/'.length);
    if (!encoded) return location.href;
    
    try {
      let decoded;
      let extraPath = '';
      
      // Check if URL-encoded (contains % or starts with http)
      if (encoded.includes('%') || encoded.startsWith('http')) {
        // URL-encoded: /proxy/https%3A%2F%2Fwww.youtube.com%2Fwatch
        decoded = decodeURIComponent(encoded);
      } else {
        // Base64url: /proxy/aHR0cHM6Ly93d3cueW91dHViZS5jb20/extra/path
        const match = encoded.match(/^([A-Za-z0-9_-]+)(.*)?$/);
        if (match) {
          decoded = base64urlDecode(match[1]);
          extraPath = match[2] || '';
        }
      }
      
      if (decoded && extraPath) {
        const url = new URL(decoded);
        if (extraPath.startsWith('?')) {
          url.search = extraPath;
        } else {
          const [pathname, search] = extraPath.split('?');
          url.pathname = url.pathname.replace(/\\/$/, '') + pathname;
          if (search) url.search = '?' + search;
        }
        decoded = url.href;
      }
      
      return decoded || location.href;
    } catch (e) {
      console.warn('[Proxy] Failed to get current target URL:', e);
    }
    return location.href;
  }
  
  const TARGET_ORIGIN = getCurrentTargetOrigin();
  
  // Core: Rewrite URL to proxy format
  function rewriteUrl(url, baseUrl) {
    if (shouldSkip(url)) return url;
    if (isProxied(url)) return url;
    
    try {
      // Resolve relative URLs
      let absoluteUrl;
      if (url.startsWith('//')) {
        absoluteUrl = 'https:' + url;
      } else if (url.startsWith('/')) {
        // CRITICAL: Relative paths should resolve to target origin, not proxy origin!
        if (TARGET_ORIGIN) {
          absoluteUrl = TARGET_ORIGIN + url;
        } else {
          absoluteUrl = new URL(url, baseUrl || getCurrentTargetUrl()).href;
        }
      } else if (/^https?:\\/\\//i.test(url)) {
        // Check if this absolute URL points to our proxy server
        // If so, we need to extract the actual path and resolve it to target origin
        try {
          const parsed = new URL(url);
          const proxyUrl = new URL(PROXY_ORIGIN);
          if (parsed.hostname === proxyUrl.hostname && parsed.port === proxyUrl.port) {
            // This URL points to our proxy server!
            // Extract the path and resolve against target origin
            if (parsed.pathname.startsWith('/proxy/')) {
              // Already a proxy URL, return as-is
              return url;
            } else {
              // Non-proxy path on proxy server - resolve to target
              if (TARGET_ORIGIN) {
                absoluteUrl = TARGET_ORIGIN + parsed.pathname + parsed.search + parsed.hash;
              } else {
                // No target origin known, can't fix this
                console.warn('[Proxy] URL points to proxy server but no target origin:', url);
                return url;
              }
            }
          } else {
            absoluteUrl = url;
          }
        } catch (e) {
          absoluteUrl = url;
        }
      } else {
        absoluteUrl = new URL(url, baseUrl || getCurrentTargetUrl()).href;
      }
      
      // Encode for proxy
      return PROXY_PREFIX + base64urlEncode(absoluteUrl);
    } catch (e) {
      console.warn('[Proxy] Failed to rewrite URL:', url, e);
      return url;
    }
  }
  
  // Core: Decode proxy URL back to original
  function decodeUrl(proxyUrl) {
    if (!isProxied(proxyUrl)) return proxyUrl;
    
    try {
      const encoded = proxyUrl.slice(PROXY_PREFIX.length).split('/')[0].split('?')[0];
      return base64urlDecode(encoded);
    } catch (e) {
      return proxyUrl;
    }
  }
  
  // === FETCH INTERCEPTION ===
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    let url;
    if (input instanceof Request) {
      url = input.url;
    } else {
      url = String(input);
    }
    
    const rewritten = rewriteUrl(url);
    
    if (input instanceof Request && rewritten !== url) {
      input = new Request(rewritten, input);
    } else if (rewritten !== url) {
      input = rewritten;
    }
    
    return originalFetch.call(this, input, init);
  };
  
  // === CREATEELEMENT INTERCEPTION ===
  // Strip integrity/crossorigin from dynamically created script/link elements
  const originalCreateElement = document.createElement.bind(document);
  document.createElement = function(tagName, options) {
    const element = originalCreateElement(tagName, options);
    const tag = tagName.toLowerCase();
    
    // For scripts and links, override integrity property to prevent it from being set
    if (tag === 'script' || tag === 'link') {
      // Make integrity and crossOrigin properties no-ops
      Object.defineProperty(element, 'integrity', {
        get: () => '',
        set: (v) => { console.log('[Proxy] Blocked integrity set on', tag); },
        configurable: true
      });
      Object.defineProperty(element, 'crossOrigin', {
        get: () => null,
        set: (v) => { /* silently ignore */ },
        configurable: true
      });
    }
    
    return element;
  };
  
  // === XMLHTTPREQUEST INTERCEPTION ===
  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    const rewritten = rewriteUrl(String(url));
    return originalXHROpen.call(this, method, rewritten, ...rest);
  };
  
  // === WEBSOCKET INTERCEPTION ===
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    // WebSocket URLs need special handling
    // Convert ws/wss to http/https for proxy, then back
    let rewritten = String(url);
    
    if (rewritten.startsWith('wss://') || rewritten.startsWith('ws://')) {
      // For now, connect directly - WebSocket proxying requires special handling
      // A full implementation would need a WebSocket proxy server
      console.warn('[Proxy] WebSocket connection:', url);
    }
    
    return new OriginalWebSocket(rewritten, protocols);
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;
  
  // === DYNAMIC IMPORT INTERCEPTION ===
  // Note: Native import() cannot be directly overridden
  // But we can handle importScripts in workers
  if (typeof importScripts === 'function') {
    const originalImportScripts = importScripts;
    self.importScripts = function(...urls) {
      const rewritten = urls.map(url => rewriteUrl(String(url)));
      return originalImportScripts.apply(this, rewritten);
    };
  }
  
  // === HISTORY API INTERCEPTION ===
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  
  history.pushState = function(state, title, url) {
    if (url) {
      url = rewriteUrl(String(url));
    }
    return originalPushState.call(this, state, title, url);
  };
  
  history.replaceState = function(state, title, url) {
    if (url) {
      url = rewriteUrl(String(url));
    }
    return originalReplaceState.call(this, state, title, url);
  };
  
  // === LOCATION OVERRIDE ===
  // Create a proxy for location to intercept assignments
  try {
    const locationDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
    if (locationDescriptor && locationDescriptor.configurable !== false) {
      // Can't easily override location, but we can intercept navigation
    }
  } catch (e) {}
  
  // === ELEMENT ATTRIBUTE INTERCEPTION ===
  const URL_ATTRIBUTES = {
    'a': ['href'],
    'link': ['href'],
    'script': ['src'],
    'img': ['src'],
    'source': ['src'],
    'video': ['src', 'poster'],
    'audio': ['src'],
    'iframe': ['src'],
    'embed': ['src'],
    'object': ['data'],
    'form': ['action'],
    'input': ['src', 'formaction'],
    'area': ['href'],
    'track': ['src'],
  };
  
  // === STRIP INTEGRITY ATTRIBUTES ===
  // Subresource Integrity (SRI) fails when URLs are rewritten through proxy
  // because the content hash changes. We need to strip these before they're set.
  const originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    const tagName = this.tagName?.toLowerCase();
    const attrName = name.toLowerCase();
    
    // Block integrity and crossorigin attributes - they break proxied resources
    if (attrName === 'integrity' || attrName === 'crossorigin') {
      console.log('[Proxy] Stripped', attrName, 'attribute from', tagName);
      return; // Don't set these attributes
    }
    
    const urlAttrs = URL_ATTRIBUTES[tagName] || [];
    if (urlAttrs.includes(attrName) && value && typeof value === 'string') {
      value = rewriteUrl(value);
    }
    
    return originalSetAttribute.call(this, name, value);
  };
  
  // === PROPERTY SETTERS ===
  function interceptProperty(proto, prop) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
    if (!descriptor || !descriptor.set) return;
    
    const originalSet = descriptor.set;
    descriptor.set = function(value) {
      if (value && typeof value === 'string') {
        value = rewriteUrl(value);
      }
      return originalSet.call(this, value);
    };
    
    Object.defineProperty(proto, prop, descriptor);
  }
  
  // Intercept href/src setters
  try {
    interceptProperty(HTMLAnchorElement.prototype, 'href');
    interceptProperty(HTMLLinkElement.prototype, 'href');
    interceptProperty(HTMLScriptElement.prototype, 'src');
    interceptProperty(HTMLImageElement.prototype, 'src');
    interceptProperty(HTMLIFrameElement.prototype, 'src');
    interceptProperty(HTMLSourceElement.prototype, 'src');
    interceptProperty(HTMLVideoElement.prototype, 'src');
    interceptProperty(HTMLVideoElement.prototype, 'poster');
    interceptProperty(HTMLAudioElement.prototype, 'src');
    interceptProperty(HTMLEmbedElement.prototype, 'src');
    interceptProperty(HTMLObjectElement.prototype, 'data');
    interceptProperty(HTMLFormElement.prototype, 'action');
    interceptProperty(HTMLInputElement.prototype, 'src');
    interceptProperty(HTMLTrackElement.prototype, 'src');
  } catch (e) {
    console.warn('[Proxy] Failed to intercept property setters:', e);
  }
  
  // === SRCSET HANDLING ===
  function rewriteSrcset(srcset) {
    if (!srcset) return srcset;
    return srcset.split(',').map(part => {
      const trimmed = part.trim();
      const match = trimmed.match(/^(\\S+)(\\s+.*)?$/);
      if (!match) return part;
      const url = match[1];
      const descriptor = match[2] || '';
      return rewriteUrl(url) + descriptor;
    }).join(', ');
  }
  
  try {
    const srcsetDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'srcset');
    if (srcsetDescriptor && srcsetDescriptor.set) {
      const originalSet = srcsetDescriptor.set;
      srcsetDescriptor.set = function(value) {
        return originalSet.call(this, rewriteSrcset(value));
      };
      Object.defineProperty(HTMLImageElement.prototype, 'srcset', srcsetDescriptor);
    }
    
    const sourceSrcsetDescriptor = Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype, 'srcset');
    if (sourceSrcsetDescriptor && sourceSrcsetDescriptor.set) {
      const originalSet = sourceSrcsetDescriptor.set;
      sourceSrcsetDescriptor.set = function(value) {
        return originalSet.call(this, rewriteSrcset(value));
      };
      Object.defineProperty(HTMLSourceElement.prototype, 'srcset', sourceSrcsetDescriptor);
    }
  } catch (e) {}
  
  // === INNERHTML INTERCEPTION ===
  // This is complex - we use MutationObserver instead
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            processElement(node);
          }
        }
      } else if (mutation.type === 'attributes') {
        const target = mutation.target;
        const attrName = mutation.attributeName?.toLowerCase();
        const tagName = target.tagName?.toLowerCase();
        
        const urlAttrs = URL_ATTRIBUTES[tagName] || [];
        if (urlAttrs.includes(attrName)) {
          const value = target.getAttribute(attrName);
          if (value && !isProxied(value) && !shouldSkip(value)) {
            const rewritten = rewriteUrl(value);
            if (rewritten !== value) {
              originalSetAttribute.call(target, attrName, rewritten);
            }
          }
        }
      }
    }
  });
  
  function processElement(element) {
    const tagName = element.tagName?.toLowerCase();
    const urlAttrs = URL_ATTRIBUTES[tagName] || [];
    
    // Strip integrity and crossorigin attributes from scripts/links
    if (tagName === 'script' || tagName === 'link') {
      if (element.hasAttribute('integrity')) {
        element.removeAttribute('integrity');
        console.log('[Proxy] Removed integrity from existing', tagName);
      }
      if (element.hasAttribute('crossorigin')) {
        element.removeAttribute('crossorigin');
      }
    }
    
    for (const attr of urlAttrs) {
      const value = element.getAttribute(attr);
      if (value && !isProxied(value) && !shouldSkip(value)) {
        const rewritten = rewriteUrl(value);
        if (rewritten !== value) {
          originalSetAttribute.call(element, attr, rewritten);
        }
      }
    }
    
    // Handle srcset
    if (element.srcset && !isProxied(element.srcset)) {
      const rewritten = rewriteSrcset(element.srcset);
      if (rewritten !== element.srcset) {
        element.srcset = rewritten;
      }
    }
    
    // Handle inline styles with url()
    if (element.style?.cssText) {
      const style = element.style.cssText;
      if (style.includes('url(') && !isProxied(style)) {
        const rewritten = style.replace(
          /url\\s*\\(\\s*(['"]?)([^'"\\)]+)\\1\\s*\\)/gi,
          (match, quote, url) => {
            if (shouldSkip(url) || isProxied(url)) return match;
            return 'url(' + quote + rewriteUrl(url) + quote + ')';
          }
        );
        if (rewritten !== style) {
          element.style.cssText = rewritten;
        }
      }
    }
    
    // Process children
    for (const child of element.children) {
      processElement(child);
    }
  }
  
  // Start observing
  observer.observe(document.documentElement || document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href', 'src', 'action', 'data', 'poster', 'srcset', 'formaction'],
  });
  
  // === WINDOW.OPEN INTERCEPTION ===
  const originalOpen = window.open;
  window.open = function(url, ...args) {
    if (url && typeof url === 'string') {
      url = rewriteUrl(url);
    }
    return originalOpen.call(this, url, ...args);
  };
  
  // === FORM SUBMISSION INTERCEPTION ===
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (form.action && !isProxied(form.action)) {
      form.action = rewriteUrl(form.action);
    }
  }, true);
  
  // === LINK CLICK INTERCEPTION ===
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (link) {
      const href = link.getAttribute('href');
      if (href && !isProxied(href) && !shouldSkip(href)) {
        const rewritten = rewriteUrl(href);
        if (rewritten !== href) {
          originalSetAttribute.call(link, 'href', rewritten);
        }
      }
    }
  }, true);
  
  // === EXPOSE UTILITIES ===
  window.__PROXY__ = {
    rewriteUrl,
    decodeUrl,
    getCurrentTargetUrl,
    getCurrentTargetOrigin,
    PROXY_ORIGIN,
    TARGET_ORIGIN,
  };
  
  console.log('[Proxy] Runtime initialized for:', TARGET_ORIGIN);
})();
`;
}

/**
 * Generate the script tag for injection into HTML
 */
export function getRuntimeScriptTag(proxyOrigin, targetOrigin) {
  const script = getRuntimeScript(proxyOrigin);
  return `<script data-proxy-runtime="true">${script}</script>`;
}
