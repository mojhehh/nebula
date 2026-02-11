/**
 * HTML Rewriter
 * 
 * Strategy:
 * Use regex-based rewriting to preserve document structure EXACTLY
 * This is critical for YouTube which embeds massive JSON blobs in script tags
 * 
 * DOM parsing/serialization can corrupt JSON data, breaking the page
 */

import { rewriteUrl, resolveUrl, isDataOrBlobUrl } from './url-utils.js';
import { getRuntimeScriptTag } from './runtime-inject.js';

/**
 * Find the base URL from a <base> tag if present
 */
function findBaseHref(html) {
  const match = html.match(/<base[^>]+href\s*=\s*["']([^"']+)["']/i);
  return match ? match[1] : null;
}

/**
 * Rewrite a single URL attribute value
 */
function rewriteAttrUrl(url, baseUrl, proxyOrigin) {
  if (!url || isDataOrBlobUrl(url)) return url;
  if (url.startsWith('#')) return url;
  if (url.startsWith('javascript:')) return url;
  return rewriteUrl(url, baseUrl, proxyOrigin);
}

/**
 * Rewrite srcset attribute
 */
function rewriteSrcset(srcset, baseUrl, proxyOrigin) {
  if (!srcset) return srcset;
  
  return srcset.split(',').map(part => {
    const trimmed = part.trim();
    const match = trimmed.match(/^(\S+)(\s+.*)?$/);
    if (!match) return part;
    
    const url = match[1];
    const descriptor = match[2] || '';
    
    const rewrittenUrl = rewriteAttrUrl(url, baseUrl, proxyOrigin);
    return rewrittenUrl + descriptor;
  }).join(', ');
}

/**
 * Main HTML rewrite function - uses regex to preserve document structure
 */
export function rewriteHtml(html, targetUrl, proxyOrigin) {
  // Extract base URL
  let baseUrl = targetUrl;
  const baseHref = findBaseHref(html);
  if (baseHref) {
    baseUrl = resolveUrl(baseHref, targetUrl);
  }
  
  // Get target origin
  let targetOrigin;
  try {
    targetOrigin = new URL(targetUrl).origin;
  } catch (e) {
    targetOrigin = '';
  }
  
  // Inject runtime script at the very beginning (after doctype/html tag)
  const runtimeScript = getRuntimeScriptTag(proxyOrigin, targetOrigin);
  
  // Find injection point - after <!DOCTYPE> and <html> tag
  let injectionPoint = 0;
  const doctypeMatch = html.match(/^(\s*<!DOCTYPE[^>]*>)/i);
  if (doctypeMatch) {
    injectionPoint = doctypeMatch[0].length;
  }
  
  const htmlTagMatch = html.slice(injectionPoint).match(/^(\s*<html[^>]*>)/i);
  if (htmlTagMatch) {
    injectionPoint += htmlTagMatch[0].length;
  }
  
  html = html.slice(0, injectionPoint) + runtimeScript + html.slice(injectionPoint);
  
  // Rewrite URL-bearing attributes using regex
  // This preserves ALL other content exactly as-is
  
  // Pattern for common URL attributes
  const urlAttrs = [
    'href', 'src', 'action', 'data', 'poster', 'background',
    'cite', 'longdesc', 'formaction'
  ];
  
  // Rewrite each URL attribute
  for (const attr of urlAttrs) {
    // Match attribute="value" or attribute='value'
    const pattern = new RegExp(
      `(\\s${attr}\\s*=\\s*)(["'])([^"']*?)\\2`,
      'gi'
    );
    
    html = html.replace(pattern, (match, prefix, quote, url) => {
      const rewritten = rewriteAttrUrl(url, baseUrl, proxyOrigin);
      return prefix + quote + rewritten + quote;
    });
  }
  
  // Rewrite srcset separately (complex format)
  html = html.replace(
    /(\ssrcset\s*=\s*)(["'])([^"']*?)\2/gi,
    (match, prefix, quote, srcset) => {
      const rewritten = rewriteSrcset(srcset, baseUrl, proxyOrigin);
      return prefix + quote + rewritten + quote;
    }
  );
  
  // Rewrite CSS url() in style attributes
  html = html.replace(
    /(\sstyle\s*=\s*)(["'])([^"']*?)\2/gi,
    (match, prefix, quote, style) => {
      const rewritten = style.replace(
        /url\s*\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi,
        (urlMatch, urlQuote, url) => {
          if (isDataOrBlobUrl(url)) return urlMatch;
          const rewrittenUrl = rewriteAttrUrl(url, baseUrl, proxyOrigin);
          return `url(${urlQuote}${rewrittenUrl}${urlQuote})`;
        }
      );
      return prefix + quote + rewritten + quote;
    }
  );
  
  // Remove integrity attributes (they'll fail after rewriting)
  html = html.replace(/\s+integrity\s*=\s*["'][^"']*["']/gi, '');
  
  // Remove CSP meta tags
  html = html.replace(
    /<meta[^>]+http-equiv\s*=\s*["']content-security-policy["'][^>]*>/gi,
    ''
  );
  
  // Handle meta refresh
  html = html.replace(
    /(<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]+content\s*=\s*["'])(\d+\s*;\s*url\s*=\s*)([^"']+)(["'][^>]*>)/gi,
    (match, prefix, delay, url, suffix) => {
      const rewritten = rewriteAttrUrl(url.trim(), baseUrl, proxyOrigin);
      return prefix + delay + rewritten + suffix;
    }
  );
  
  return html;
}
