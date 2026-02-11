/**
 * CSS Rewriter
 * 
 * Strategy:
 * - Parse CSS and rewrite url() references
 * - Handle @import rules
 * - Preserve all other CSS exactly
 */

import { rewriteUrl, isDataOrBlobUrl } from './url-utils.js';

/**
 * Rewrite url() references in CSS
 */
function rewriteUrlFunction(css, baseUrl, proxyOrigin) {
  // Match url() with various quote styles
  return css.replace(
    /url\s*\(\s*(['"]?)([^'")\s][^)]*?)\1\s*\)/gi,
    (match, quote, url) => {
      // Trim whitespace from URL
      url = url.trim();
      
      // Skip data/blob URLs
      if (isDataOrBlobUrl(url)) {
        return match;
      }
      
      // Skip empty URLs
      if (!url) {
        return match;
      }
      
      // Rewrite the URL
      const rewrittenUrl = rewriteUrl(url, baseUrl, proxyOrigin);
      
      // Preserve original quote style
      return `url(${quote}${rewrittenUrl}${quote})`;
    }
  );
}

/**
 * Rewrite @import rules
 */
function rewriteImportRules(css, baseUrl, proxyOrigin) {
  // Match @import with url()
  css = css.replace(
    /@import\s+url\s*\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi,
    (match, quote, url) => {
      if (isDataOrBlobUrl(url)) return match;
      const rewrittenUrl = rewriteUrl(url, baseUrl, proxyOrigin);
      return `@import url(${quote}${rewrittenUrl}${quote})`;
    }
  );
  
  // Match @import with direct string
  css = css.replace(
    /@import\s+(['"])([^'"]+)\1/gi,
    (match, quote, url) => {
      if (isDataOrBlobUrl(url)) return match;
      const rewrittenUrl = rewriteUrl(url, baseUrl, proxyOrigin);
      return `@import ${quote}${rewrittenUrl}${quote}`;
    }
  );
  
  return css;
}

/**
 * Rewrite @font-face src descriptors
 * These can have multiple url() with format hints
 */
function rewriteFontFaceSrc(css, baseUrl, proxyOrigin) {
  return css.replace(
    /(@font-face\s*\{[^}]*src\s*:\s*)([^;]+)(;[^}]*\})/gi,
    (match, before, srcValue, after) => {
      // Rewrite url() in the src value
      const rewrittenSrc = srcValue.replace(
        /url\s*\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi,
        (urlMatch, quote, url) => {
          if (isDataOrBlobUrl(url)) return urlMatch;
          const rewrittenUrl = rewriteUrl(url, baseUrl, proxyOrigin);
          return `url(${quote}${rewrittenUrl}${quote})`;
        }
      );
      return before + rewrittenSrc + after;
    }
  );
}

/**
 * Main CSS rewrite function
 */
export function rewriteCss(css, targetUrl, proxyOrigin) {
  if (!css) return css;
  
  // Rewrite @import rules first
  css = rewriteImportRules(css, targetUrl, proxyOrigin);
  
  // Rewrite all url() references
  css = rewriteUrlFunction(css, targetUrl, proxyOrigin);
  
  return css;
}
