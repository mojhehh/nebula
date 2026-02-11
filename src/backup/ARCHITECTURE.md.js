/**
 * CroxyProxy-Style Architecture: The REAL way to build a web proxy
 * 
 * ============================================================================
 * WHY URL-REWRITING PROXIES (like Ultraviolet) FAIL:
 * ============================================================================
 * 
 * 1. SAME-ORIGIN POLICY VIOLATIONS
 *    Your error log shows: "Domains, protocols and ports must match"
 *    
 *    When you do: yourproxy.com/proxy/https%3A%2F%2Fyoutube.com
 *    - Main page is from: yourproxy.com
 *    - Iframes try to load: yourproxy.com/proxy/... (different encoded URLs)
 *    - Browser sees DIFFERENT paths = DIFFERENT origins for security
 *    - YouTube's JS checks window.location and freaks out
 * 
 * 2. JAVASCRIPT INTEGRITY ISSUES
 *    YouTube (and many sites) do:
 *    - Check if window.location.hostname === 'www.youtube.com'
 *    - Verify script integrity hashes (rewriting changes the hash!)
 *    - Use CSP to restrict where scripts load from
 * 
 * 3. COMPLEX STATE MANAGEMENT
 *    - Cookies are tied to the PROXY domain, not target
 *    - localStorage/sessionStorage is per-origin (proxy origin)
 *    - IndexedDB has same issues
 *    - Service Workers get confused
 * 
 * ============================================================================
 * HOW CROXYPROXY SOLVES THIS (The Server Pool Architecture):
 * ============================================================================
 * 
 * Step 1: User visits croxyproxy.com
 *         ↓
 * Step 2: Clicks "Go" to browse youtube.com
 *         ↓
 * Step 3: croxyproxy.com/servers - Load balancer picks a server
 *         ↓
 * Step 4: Redirects to https://random-ip-or-subdomain/
 *         (e.g., https://108.181.88.29/ or https://p47.croxyproxy.net/)
 *         ↓
 * Step 5: THAT server becomes a TRANSPARENT proxy
 *         - ALL your requests go to that ONE server
 *         - The server forwards to YouTube and returns responses
 *         - URLs don't need encoding because the server tracks your session!
 * 
 * KEY INSIGHT: Each proxy server in their pool acts as a dedicated gateway.
 * From the browser's perspective, you're only talking to ONE origin.
 * 
 * ============================================================================
 * THE MAGIC: SESSION-BASED TARGET TRACKING
 * ============================================================================
 * 
 * Instead of encoding URLs like:
 *   /proxy/https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3Dxyz
 * 
 * The proxy server REMEMBERS your target via:
 *   - Cookie: __target=youtube.com
 *   - Server-side session: sessionId -> { target: 'https://youtube.com' }
 * 
 * So when you request:
 *   GET /watch?v=xyz
 * 
 * The proxy knows to forward to:
 *   https://youtube.com/watch?v=xyz
 * 
 * This means:
 *   ✅ window.location.pathname shows /watch?v=xyz (looks normal!)
 *   ✅ All iframes load from the SAME origin (the proxy server)
 *   ✅ No URL encoding = No integrity hash mismatches
 *   ✅ Relative URLs just work!
 * 
 * ============================================================================
 * ARCHITECTURE FOR PRODUCTION:
 * ============================================================================
 * 
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                           MAIN DOMAIN                                   │
 * │                        yourproxy.com                                    │
 * │   ┌─────────────────────────────────────────────────────────────────┐   │
 * │   │  Landing Page + URL Input                                       │   │
 * │   │  Load Balancer / Server Selector                                │   │
 * │   │  User Management / Premium Features                             │   │
 * │   └─────────────────────────────────────────────────────────────────┘   │
 * └─────────────────────────────────────────────────────────────────────────┘
 *                                    │
 *                                    │ Redirect to available proxy server
 *                                    ▼
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                         PROXY SERVER POOL                               │
 * │                                                                         │
 * │   ┌───────────────┐   ┌───────────────┐   ┌───────────────┐            │
 * │   │  Server 1     │   │  Server 2     │   │  Server N     │            │
 * │   │ 108.181.88.29 │   │ 143.244.207.X │   │  ...          │            │
 * │   │ or            │   │ or            │   │               │            │
 * │   │ p1.proxy.com  │   │ p2.proxy.com  │   │               │            │
 * │   └───────────────┘   └───────────────┘   └───────────────┘            │
 * │                                                                         │
 * │   Each server:                                                          │
 * │   - Runs transparent-proxy.js                                           │
 * │   - Handles ~1000 concurrent sessions                                   │
 * │   - SSL termination with wildcard cert (or Let's Encrypt)              │
 * │   - Tracks sessions via cookies + server-side state                     │
 * │   - Streams video/audio efficiently                                     │
 * └─────────────────────────────────────────────────────────────────────────┘
 *                                    │
 *                                    │ Proxy forwards requests
 *                                    ▼
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                          TARGET WEBSITES                                │
 * │        youtube.com  │  google.com  │  reddit.com  │  etc.              │
 * └─────────────────────────────────────────────────────────────────────────┘
 * 
 * ============================================================================
 * WHY THIS WORKS FOR YOUTUBE (and complex sites):
 * ============================================================================
 * 
 * 1. SINGLE ORIGIN
 *    Browser only sees: https://proxy-server-47.example.com
 *    All iframes, scripts, API calls go to SAME origin
 *    No "Domains, protocols and ports must match" errors!
 * 
 * 2. NATIVE URLS
 *    - /watch?v=xyz instead of /proxy/encoded-garbage
 *    - window.location.pathname works normally
 *    - history.pushState works normally
 *    - Relative URLs resolve correctly
 * 
 * 3. PROPER COOKIE HANDLING
 *    - Target site's cookies are stored on proxy domain (mapped)
 *    - Session state persists correctly
 *    - Login flows work properly
 * 
 * 4. NO JAVASCRIPT REWRITING
 *    - Scripts load byte-for-byte identical
 *    - Integrity hashes match
 *    - Web Workers work
 *    - Service Workers can be blocked/proxied
 * 
 * ============================================================================
 * IMPLEMENTATION FILES:
 * ============================================================================
 * 
 * 1. transparent-proxy.js - Single-server transparent proxy
 *    - Session-based target tracking
 *    - Minimal URL rewriting (only for cross-origin redirects)
 *    - Proper header handling
 * 
 * 2. proxy-server-pool.js - Production multi-server setup
 *    - Redis for shared session state
 *    - Server health checking
 *    - Load balancing
 * 
 * 3. landing-page/ - Main domain frontend
 *    - URL input form
 *    - Server selector
 *    - Premium features
 * 
 * ============================================================================
 * RUNNING THE PROXY:
 * ============================================================================
 * 
 * Development (single server):
 *   node src/transparent-proxy.js
 *   Open: http://localhost:8080
 * 
 * Production:
 *   1. Deploy multiple proxy servers (different IPs or subdomains)
 *   2. Put landing page on main domain
 *   3. Landing page redirects to available proxy server
 *   4. Each proxy server handles sessions independently
 * 
 * ============================================================================
 * LIMITATIONS & SOLUTIONS:
 * ============================================================================
 * 
 * 1. WebSockets
 *    - Need to proxy WS connections too
 *    - See ws-proxy.js for implementation
 * 
 * 2. Service Workers
 *    - These are tricky - need to either block or intercept registration
 *    - Currently injecting script to override navigator.serviceWorker
 * 
 * 3. Cross-Origin Redirects
 *    - When site redirects to different domain, need to update session
 *    - Currently handled via /browse/ path
 * 
 * 4. Multiple Targets
 *    - If page loads resources from CDN, those requests go to proxy
 *    - Proxy forwards based on Referer header or tracks in session
 */

export default {
  // This file is documentation - see transparent-proxy.js for implementation
};
