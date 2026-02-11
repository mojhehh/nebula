/**
 * Cookie Handler
 * 
 * Strategy:
 * - Scope cookies per proxied origin to prevent cross-site leaks
 * - Rewrite Set-Cookie headers to work with the proxy domain
 * - Preserve SameSite, Secure, HttpOnly attributes appropriately
 */

import { URL } from 'url';

/**
 * Parse a Set-Cookie header string into components
 */
function parseSetCookie(cookieStr) {
  const parts = cookieStr.split(';').map(p => p.trim());
  const [nameValue, ...attrs] = parts;
  
  const eqIndex = nameValue.indexOf('=');
  const name = eqIndex > 0 ? nameValue.substring(0, eqIndex) : nameValue;
  const value = eqIndex > 0 ? nameValue.substring(eqIndex + 1) : '';
  
  const attributes = {};
  for (const attr of attrs) {
    const [key, val] = attr.split('=').map(s => s.trim());
    attributes[key.toLowerCase()] = val || true;
  }
  
  return { name, value, attributes };
}

/**
 * Serialize cookie back to Set-Cookie header format
 */
function serializeSetCookie(cookie) {
  let result = `${cookie.name}=${cookie.value}`;
  
  for (const [key, val] of Object.entries(cookie.attributes)) {
    if (val === true) {
      result += `; ${key}`;
    } else if (val) {
      result += `; ${key}=${val}`;
    }
  }
  
  return result;
}

/**
 * Get a scope prefix for cookies based on target origin
 * This prevents cookies from different origins from conflicting
 */
function getScopePrefix(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    // Use hostname hash as prefix
    const hash = Buffer.from(parsed.hostname).toString('base64url').substring(0, 8);
    return `__p_${hash}_`;
  } catch (e) {
    return '__p_unknown_';
  }
}

/**
 * Rewrite Set-Cookie headers for proxy
 */
export function rewriteSetCookieHeader(cookies, targetUrl, proxyOrigin) {
  if (!cookies) return cookies;
  
  const cookieArray = Array.isArray(cookies) ? cookies : [cookies];
  const scopePrefix = getScopePrefix(targetUrl);
  
  return cookieArray.map(cookieStr => {
    const cookie = parseSetCookie(cookieStr);
    
    // Prefix cookie name with scope
    cookie.name = scopePrefix + cookie.name;
    
    // Remove Domain attribute - cookie should be scoped to proxy domain
    delete cookie.attributes.domain;
    
    // Set Path to / so cookies work across all proxied paths
    cookie.attributes.path = '/';
    
    // Handle Secure attribute
    // If proxy is HTTPS, keep Secure; otherwise remove it
    if (cookie.attributes.secure) {
      try {
        const proxyUrl = new URL(proxyOrigin);
        if (proxyUrl.protocol !== 'https:') {
          delete cookie.attributes.secure;
        }
      } catch (e) {
        delete cookie.attributes.secure;
      }
    }
    
    // Adjust SameSite for proxy context
    // Using Lax allows navigation while preventing most CSRF
    if (cookie.attributes.samesite === 'none' || cookie.attributes.samesite === 'None') {
      // SameSite=None requires Secure
      cookie.attributes.samesite = 'Lax';
      delete cookie.attributes.secure;
    }
    
    return serializeSetCookie(cookie);
  });
}

/**
 * Rewrite Cookie header from client for upstream
 * Removes the scope prefix before sending to target
 */
export function rewriteCookieHeader(cookieHeader, targetUrl) {
  if (!cookieHeader) return cookieHeader;
  
  const scopePrefix = getScopePrefix(targetUrl);
  
  const cookies = cookieHeader.split(';').map(c => c.trim());
  const rewritten = [];
  
  for (const cookie of cookies) {
    const [name, value] = cookie.split('=');
    if (name && name.startsWith(scopePrefix)) {
      // Remove prefix and include
      const originalName = name.substring(scopePrefix.length);
      rewritten.push(`${originalName}=${value}`);
    }
    // Skip cookies with different scope prefixes
  }
  
  return rewritten.join('; ');
}

/**
 * Handle cookies in request flow
 */
export function handleCookies(clientReq, targetUrl) {
  const cookieHeader = clientReq.headers.cookie;
  if (cookieHeader) {
    return rewriteCookieHeader(cookieHeader, targetUrl);
  }
  return '';
}
