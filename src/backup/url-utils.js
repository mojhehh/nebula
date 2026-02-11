/**
 * URL Utilities for Proxy Rewriting
 * 
 * URL Encoding Strategy:
 * - Target URLs are encoded in the path as: /proxy/{encodedUrl}
 * - This keeps all requests on the proxy origin
 * - The encoded URL preserves the full target URL including protocol
 */

import { URL } from 'url';

/**
 * Encode a target URL for the proxy path
 * Format: /proxy/{base64url-encoded-url}
 */
export function encodeProxyUrl(targetUrl, proxyOrigin) {
  if (!targetUrl) return proxyOrigin;
  
  // Handle protocol-relative URLs
  if (targetUrl.startsWith('//')) {
    targetUrl = 'https:' + targetUrl;
  }
  
  // Normalize the URL
  try {
    const parsed = new URL(targetUrl);
    targetUrl = parsed.href;
  } catch (e) {
    // If it fails to parse, return as-is
    return targetUrl;
  }
  
  // Use URL-safe base64 encoding
  const encoded = Buffer.from(targetUrl).toString('base64url');
  return `${proxyOrigin}/proxy/${encoded}`;
}

/**
 * Decode a proxy path back to the target URL
 * Returns null if not a valid proxy path
 * 
 * Supports two formats:
 * 1. Base64url: /proxy/aHR0cHM6Ly93d3cueW91dHViZS5jb20
 * 2. URL-encoded: /proxy/https%3A%2F%2Fwww.youtube.com
 */
export function decodeProxyUrl(proxyPath, proxyOrigin) {
  // Handle full URL or path
  let path = proxyPath;
  if (proxyPath.startsWith('http://') || proxyPath.startsWith('https://')) {
    try {
      const parsed = new URL(proxyPath);
      path = parsed.pathname + parsed.search;
    } catch (e) {
      return null;
    }
  }
  
  // Check for proxy prefix
  if (!path.startsWith('/proxy/')) return null;
  
  const encodedPart = path.slice('/proxy/'.length);
  if (!encodedPart) return null;
  
  try {
    let targetUrl;
    
    // Detect format: if it contains % or starts with http, it's URL-encoded
    // Otherwise it's base64url
    if (encodedPart.includes('%') || encodedPart.startsWith('http')) {
      // URL-encoded format: /proxy/https%3A%2F%2Fwww.youtube.com/path
      // First decode the URL encoding
      const decoded = decodeURIComponent(encodedPart);
      
      // The decoded string should be a full URL
      // e.g., "https://www.youtube.com/path?query=1"
      targetUrl = decoded;
    } else {
      // Base64url format: /proxy/aHR0cHM6Ly93d3cueW91dHViZS5jb20/extra/path
      // Extract the base64 part (stops at first / or ?)
      const match = encodedPart.match(/^([A-Za-z0-9_-]+)(.*)?$/);
      if (!match) return null;
      
      // Decode base64url
      targetUrl = Buffer.from(match[1], 'base64url').toString('utf-8');
      
      // Append any additional path/query from the proxy URL
      if (match[2]) {
        const parsed = new URL(targetUrl);
        // If additional part starts with ?, it's a query string
        if (match[2].startsWith('?')) {
          parsed.search = match[2];
        } else {
          // Otherwise append to path
          const [extraPath, extraQuery] = match[2].split('?');
          parsed.pathname = parsed.pathname.replace(/\/$/, '') + extraPath;
          if (extraQuery) {
            parsed.search = '?' + extraQuery;
          }
        }
        targetUrl = parsed.href;
      }
    }
    
    // Validate it's a proper URL
    new URL(targetUrl);
    return targetUrl;
  } catch (e) {
    return null;
  }
}

/**
 * Get the proxy origin from the request
 */
export function getProxyOrigin(req) {
  const host = req.headers.host || 'localhost:3000';
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  return `${protocol}://${host}`;
}

/**
 * Check if a URL is absolute
 */
export function isAbsoluteUrl(url) {
  return /^(?:https?:)?\/\//i.test(url);
}

/**
 * Check if URL is a data URI or blob
 */
export function isDataOrBlobUrl(url) {
  return /^(?:data|blob|javascript|about|mailto):/i.test(url);
}

/**
 * Resolve a URL relative to a base URL
 */
export function resolveUrl(url, baseUrl) {
  if (!url) return url;
  
  // Skip data/blob URLs
  if (isDataOrBlobUrl(url)) {
    return url;
  }
  
  // Handle protocol-relative URLs
  if (url.startsWith('//')) {
    try {
      const baseParsed = new URL(baseUrl);
      return baseParsed.protocol + url;
    } catch (e) {
      return 'https:' + url;
    }
  }
  
  // Handle absolute URLs
  if (isAbsoluteUrl(url)) {
    return url;
  }
  
  // Resolve relative URL
  try {
    return new URL(url, baseUrl).href;
  } catch (e) {
    return url;
  }
}

/**
 * Rewrite a URL to go through the proxy
 * This is the core function used throughout the rewriter
 */
export function rewriteUrl(url, baseUrl, proxyOrigin) {
  if (!url) return url;
  
  // Skip special URLs
  if (isDataOrBlobUrl(url)) {
    return url;
  }
  
  // Skip fragment-only URLs
  if (url.startsWith('#')) {
    return url;
  }
  
  // Resolve to absolute URL first
  const absoluteUrl = resolveUrl(url, baseUrl);
  
  // Skip if resolution failed
  if (!absoluteUrl || absoluteUrl === url && !isAbsoluteUrl(url)) {
    return url;
  }
  
  // Encode through proxy
  return encodeProxyUrl(absoluteUrl, proxyOrigin);
}

/**
 * Extract the target origin from a proxied URL
 */
export function getTargetOrigin(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return parsed.origin;
  } catch (e) {
    return null;
  }
}

/**
 * Create a scope key for cookies based on target origin
 */
export function getCookieScope(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return parsed.hostname;
  } catch (e) {
    return 'unknown';
  }
}
