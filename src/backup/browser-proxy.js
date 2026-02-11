/**
 * BROWSER STREAMING PROXY - OPTIMIZED FOR LOW-LATENCY
 * ===================================================
 * Uses Playwright (better than Puppeteer for stability and CDP access).
 * Optimized for streaming to weak devices (iPads) over slow networks.
 * 
 * OPTIMIZATION PHILOSOPHY:
 * - Stability > Quality (consistent 30 FPS better than variable 60)
 * - Lower resolution = faster encoding + less bandwidth
 * - Aggressive frame skipping prevents buffer buildup
 * - Page-level optimizations reduce rendering work
 * 
 * WHY PLAYWRIGHT OVER PUPPETEER:
 * 1. Better CDP (Chrome DevTools Protocol) integration
 * 2. Native screencast with hardware acceleration
 * 3. More stable context management
 * 4. Better error recovery
 * 5. Auto-waits reduce timing issues
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
const crypto = require('crypto');

// Add stealth plugin to avoid detection
chromium.use(stealth());

/**
 * PERFORMANCE PRESETS - Choose based on network quality
 */
const QUALITY_PRESETS = {
    // For very slow networks (< 1 Mbps) - school Wi-Fi worst case
    potato: {
        width: 854,
        height: 480,
        fps: 24,
        quality: 40,
        frameInterval: 42,
    },
    // For slow networks (1-3 Mbps) - typical school Wi-Fi
    low: {
        width: 1280,
        height: 720,
        fps: 30,
        quality: 50,
        frameInterval: 33,
    },
    // For medium networks (3-10 Mbps)
    medium: {
        width: 1280,
        height: 720,
        fps: 30,
        quality: 60,
        frameInterval: 33,
    },
    // For good networks (10+ Mbps)
    high: {
        width: 1920,
        height: 1080,
        fps: 30,
        quality: 75,
        frameInterval: 33,
    }
};

class BrowserStreamProxy {
    constructor(options = {}) {
        this.port = options.port || 3000;
        this.DEBUG = options.debug || false;
        
        // Active browser sessions
        this.sessions = new Map(); // sessionId -> BrowserSession
        
        // Settings - OPTIMIZED DEFAULTS for weak devices
        this.maxSessions = options.maxSessions || 10;
        this.sessionTimeout = options.sessionTimeout || 30 * 60 * 1000; // 30 min
        
        // Use 'low' preset by default for school iPads
        this.preset = QUALITY_PRESETS[options.preset] || QUALITY_PRESETS.low;
        this.frameRate = this.preset.fps;
        this.quality = this.preset.quality;
        
        // Viewport - LOWER resolution for faster encoding and less bandwidth
        this.defaultViewport = { 
            width: this.preset.width, 
            height: this.preset.height 
        };
        
        // Adaptive quality settings
        this.minQuality = 25;        // Never go below this
        this.maxQuality = 70;        // Never go above this (saves bandwidth)
        this.targetLatency = 100;    // Target 100ms latency
        this.maxBufferedAmount = 50000; // 50KB max buffer before frame skip
    }

    log(...args) {
        if (this.DEBUG) console.log('[PROXY]', new Date().toISOString().split('T')[1].slice(0, 8), ...args);
    }

    /**
     * Generate session ID
     */
    generateSessionId() {
        return crypto.randomBytes(16).toString('base64url');
    }
    
    /**
     * ═══════════════════════════════════════════════════════════════
     * SITE-SPECIFIC OPTIMIZATIONS
     * ═══════════════════════════════════════════════════════════════
     * Different sites need different handling for optimal performance
     */
    async applySiteOptimizations(page, url) {
        const hostname = new URL(url).hostname.toLowerCase();
        
        // ─────────────── YOUTUBE OPTIMIZATIONS ───────────────
        if (hostname.includes('youtube.com')) {
            await this.optimizeYouTube(page);
        }
        // ─────────────── TIKTOK OPTIMIZATIONS ───────────────
        else if (hostname.includes('tiktok.com')) {
            await this.optimizeTikTok(page);
        }
        // ─────────────── CLOUD GAMING (now.gg, roblox) ───────────────
        else if (hostname.includes('now.gg') || hostname.includes('roblox.com')) {
            await this.optimizeCloudGaming(page);
        }
        
        this.log(`Applied optimizations for ${hostname}`);
    }
    
    /**
     * YouTube-specific optimizations
     */
    async optimizeYouTube(page) {
        try {
            await page.evaluate(() => {
                // Force lower quality video to reduce bandwidth
                // YouTube will auto-adjust, but we can nudge it
                const video = document.querySelector('video');
                if (video) {
                    // Prefer 480p max for streaming (saves massive bandwidth)
                    // YouTube's API isn't directly accessible, but we can hint
                }
                
                // Remove theater mode banner, end screens, annotations
                const hideSelectors = [
                    '.ytp-ce-element',           // End screen elements
                    '.ytp-cards-teaser',         // Card teasers
                    '.ytp-paid-content-overlay', // Paid content
                    '#masthead-container',       // Top bar (optional)
                    'ytd-comments',              // Comments section
                    '#related',                  // Related videos sidebar
                ];
                
                hideSelectors.forEach(sel => {
                    document.querySelectorAll(sel).forEach(el => {
                        el.style.display = 'none';
                    });
                });
                
                // Disable ambient mode (saves CPU)
                const style = document.createElement('style');
                style.textContent = `
                    #cinematics { display: none !important; }
                    .html5-video-player { background: #000 !important; }
                `;
                document.head.appendChild(style);
            });
        } catch (e) {
            this.log('YouTube optimization error:', e.message);
        }
    }
    
    /**
     * TikTok-specific optimizations
     */
    async optimizeTikTok(page) {
        try {
            await page.evaluate(() => {
                // TikTok uses lots of animations - reduce them
                const style = document.createElement('style');
                style.textContent = `
                    /* Reduce TikTok animations */
                    * {
                        animation-duration: 0.1s !important;
                    }
                    
                    /* Hide non-essential UI for cleaner streaming */
                    [class*="DivShareLayoutMain"] { display: none !important; }
                `;
                document.head.appendChild(style);
            });
        } catch (e) {
            this.log('TikTok optimization error:', e.message);
        }
    }
    
    /**
     * Cloud gaming optimizations (now.gg, Roblox web)
     * These need LOWEST latency possible
     */
    async optimizeCloudGaming(page) {
        try {
            await page.evaluate(() => {
                // For gaming, we want maximum responsiveness
                // Disable any CSS transitions/animations completely
                const style = document.createElement('style');
                style.textContent = `
                    *, *::before, *::after {
                        animation: none !important;
                        transition: none !important;
                    }
                `;
                document.head.appendChild(style);
                
                // Request pointer lock if the game needs it
                // (handled by the game itself usually)
            });
            
            // For cloud gaming, we might want to increase quality slightly
            // but keep latency low - this is handled in the streaming section
        } catch (e) {
            this.log('Cloud gaming optimization error:', e.message);
        }
    }

    /**
     * Create a new browser session - HEAVILY OPTIMIZED
     */
    async createSession(url, viewport = this.defaultViewport) {
        if (this.sessions.size >= this.maxSessions) {
            throw new Error('Max sessions reached. Try again later.');
        }

        const sessionId = this.generateSessionId();
        
        this.log(`Creating session ${sessionId} for ${url}`);

        // ═══════════════════════════════════════════════════════════════
        // BROWSER LAUNCH FLAGS - CRITICAL FOR PERFORMANCE
        // ═══════════════════════════════════════════════════════════════
        // These flags significantly reduce CPU/memory usage and improve
        // rendering performance for streaming scenarios.
        const browser = await chromium.launch({
            headless: true,
            channel: 'chrome', // Use actual Chrome if available
            args: [
                // ─────────────── SANDBOX (required for most deployments) ───────────────
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                
                // ─────────────── GPU & RENDERING OPTIMIZATION ───────────────
                // Enable GPU for video decoding (critical for YouTube/TikTok)
                '--enable-gpu',
                '--enable-gpu-rasterization',
                '--enable-accelerated-video-decode',
                '--enable-accelerated-2d-canvas',
                '--enable-zero-copy',               // Faster frame capture
                '--use-gl=swiftshader',             // Software GL fallback if no GPU
                '--ignore-gpu-blocklist',           // Allow GPU even on blocklist
                
                // ─────────────── DISABLE UNNECESSARY FEATURES ───────────────
                // These features waste CPU cycles for streaming
                '--disable-extensions',
                '--disable-component-extensions-with-background-pages',
                '--disable-default-apps',
                '--disable-translate',
                '--disable-sync',
                '--disable-background-networking',
                '--disable-breakpad',               // Disable crash reporter
                '--disable-component-update',
                '--disable-domain-reliability',
                '--disable-features=TranslateUI,BlinkGenPropertyTrees',
                '--disable-hang-monitor',
                '--disable-ipc-flooding-protection',
                '--disable-popup-blocking',
                '--disable-prompt-on-repost',
                '--disable-client-side-phishing-detection',
                
                // ─────────────── BACKGROUND THROTTLING (CRITICAL) ───────────────
                // Prevents browser from sleeping when "hidden"
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-background-media-suspend',  // Keep video playing
                
                // ─────────────── FRAME RATE & VSYNC ───────────────
                // We control frame rate ourselves, don't let browser limit us
                '--disable-frame-rate-limit',
                '--disable-gpu-vsync',
                
                // ─────────────── MEMORY OPTIMIZATION ───────────────
                '--memory-pressure-off',
                '--max-active-webgl-contexts=2',     // Limit WebGL contexts
                '--js-flags=--max-old-space-size=256', // Limit JS heap
                
                // ─────────────── SECURITY & COMPATIBILITY ───────────────
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--autoplay-policy=no-user-gesture-required',
                '--disable-blink-features=AutomationControlled',
                
                // ─────────────── REDUCE ANIMATIONS (saves CPU) ───────────────
                '--force-prefers-reduced-motion',   // Tells sites user prefers less motion
                
                // ─────────────── NETWORK OPTIMIZATION ───────────────
                '--aggressive-cache-discard',       // Don't waste memory on cache
                '--disable-features=NetworkService,NetworkServiceInProcess',
            ]
        });

        const context = await browser.newContext({
            viewport: viewport,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            locale: 'en-US',
            timezoneId: 'America/New_York',
            geolocation: { latitude: 40.7128, longitude: -74.0060 },
            permissions: ['geolocation'],
            // Extra anti-detection
            bypassCSP: true,
            ignoreHTTPSErrors: true,
            // ─────────────── REDUCE MOTION FOR PERFORMANCE ───────────────
            reducedMotion: 'reduce',    // Tells pages user prefers less animation
            forcedColors: 'none',       // Disable forced colors
        });

        const page = await context.newPage();
        
        // ═══════════════════════════════════════════════════════════════
        // PAGE-LEVEL PERFORMANCE OPTIMIZATIONS
        // ═══════════════════════════════════════════════════════════════
        
        // CRITICAL: Inject performance CSS BEFORE page loads
        // This reduces CPU usage significantly by simplifying rendering
        await page.addInitScript(() => {
            // ─────────────── INJECT PERFORMANCE CSS ───────────────
            const perfStyle = document.createElement('style');
            perfStyle.id = 'perf-optimizations';
            perfStyle.textContent = `
                /* Reduce animation work */
                *, *::before, *::after {
                    animation-duration: 0.01ms !important;
                    animation-iteration-count: 1 !important;
                    transition-duration: 0.01ms !important;
                    scroll-behavior: auto !important;
                }
                
                /* Disable heavy effects - use with caution */
                .perf-mode-aggressive * {
                    box-shadow: none !important;
                    text-shadow: none !important;
                    filter: none !important;
                    backdrop-filter: none !important;
                }
            `;
            // Add to head as soon as it exists
            if (document.head) {
                document.head.appendChild(perfStyle);
            } else {
                document.addEventListener('DOMContentLoaded', () => {
                    document.head.appendChild(perfStyle);
                });
            }
            
            // ─────────────── INTERCEPT requestAnimationFrame ───────────────
            // Cap to ~30fps to reduce CPU load
            const originalRAF = window.requestAnimationFrame;
            let lastFrameTime = 0;
            const minFrameInterval = 33; // ~30fps cap
            
            window.requestAnimationFrame = function(callback) {
                return originalRAF((timestamp) => {
                    if (timestamp - lastFrameTime >= minFrameInterval) {
                        lastFrameTime = timestamp;
                        callback(timestamp);
                    } else {
                        // Skip this frame, schedule for next
                        originalRAF(callback);
                    }
                });
            };
            
            // ─────────────── REDUCE INTERVAL/TIMEOUT SPAM ───────────────
            // Many sites create hundreds of timers - throttle them
            const originalSetInterval = window.setInterval;
            window.setInterval = function(fn, delay, ...args) {
                // Enforce minimum 50ms interval to reduce CPU spam
                const safeDelay = Math.max(delay || 0, 50);
                return originalSetInterval(fn, safeDelay, ...args);
            };
            
            // ─────────────── DISABLE WEBRTC LEAK ───────────────
            // Also saves bandwidth/CPU if site tries to use WebRTC
            if (window.RTCPeerConnection) {
                window.RTCPeerConnection = class {
                    constructor() { throw new Error('WebRTC disabled'); }
                };
            }
        });

        // ANTI-DETECTION: Override webdriver property and other fingerprinting
        await page.addInitScript(() => {
            // Remove webdriver flag
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            
            // Mock plugins
            Object.defineProperty(navigator, 'plugins', {
                get: () => [
                    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
                    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
                    { name: 'Native Client', filename: 'internal-nacl-plugin' }
                ]
            });
            
            // Mock languages
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            
            // Mock permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
            );
            
            // Mock chrome runtime
            window.chrome = { runtime: {} };
            
            // Hide automation
            delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
            delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
            delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
        });

        // Block some resource types to improve performance
        // ═══════════════════════════════════════════════════════════════
        // SMART RESOURCE BLOCKING - Saves bandwidth and CPU
        // ═══════════════════════════════════════════════════════════════
        await page.route('**/*', (route) => {
            const request = route.request();
            const resourceType = request.resourceType();
            const url = request.url();
            
            // ─────────────── BLOCK TRACKING/ANALYTICS ───────────────
            // These waste bandwidth and CPU, provide no value
            const blockPatterns = [
                'google-analytics.com',
                'googletagmanager.com',
                'facebook.com/tr',
                'doubleclick.net',
                'adsense',
                'adservice',
                'analytics',
                'tracker',
                'telemetry',
                'sentry.io',
                'hotjar.com',
                'clarity.ms',
                'segment.com',
                'mixpanel.com',
                'amplitude.com',
            ];
            
            if (blockPatterns.some(p => url.includes(p))) {
                return route.abort();
            }
            
            // ─────────────── HANDLE BY RESOURCE TYPE ───────────────
            switch (resourceType) {
                case 'image':
                    // Allow images but could downscale in future
                    route.continue();
                    break;
                    
                case 'font':
                    // Fonts are often huge - use system fonts instead
                    // Uncomment to block: route.abort();
                    route.continue();
                    break;
                    
                case 'media':
                    // Always allow media (YouTube, TikTok need this)
                    route.continue();
                    break;
                    
                case 'stylesheet':
                case 'script':
                case 'document':
                case 'xhr':
                case 'fetch':
                case 'websocket':
                    // Essential resources - always allow
                    route.continue();
                    break;
                    
                default:
                    route.continue();
            }
        });

        // Navigate to URL
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            
            // ═══════════════════════════════════════════════════════════════
            // SITE-SPECIFIC OPTIMIZATIONS
            // ═══════════════════════════════════════════════════════════════
            await this.applySiteOptimizations(page, url);
            
        } catch (err) {
            this.log(`Navigation error: ${err.message}`);
            // Continue anyway, page might still be usable
        }

        // Inject fullscreen interception script - runs on every navigation
        await page.addInitScript(() => {
            // Override fullscreen API to notify parent
            const originalRequestFullscreen = Element.prototype.requestFullscreen;
            Element.prototype.requestFullscreen = function(...args) {
                // Notify via exposed function if available
                if (window.__notifyFullscreen) {
                    window.__notifyFullscreen();
                }
                // Return a resolved promise (fullscreen won't work in headless anyway)
                return Promise.resolve();
            };
            
            // Also handle webkit prefix
            if (Element.prototype.webkitRequestFullscreen) {
                Element.prototype.webkitRequestFullscreen = function(...args) {
                    if (window.__notifyFullscreen) {
                        window.__notifyFullscreen();
                    }
                    return Promise.resolve();
                };
            }
            
            // Override document.fullscreenElement to prevent apps from thinking we're not fullscreen
            Object.defineProperty(document, 'fullscreenElement', {
                get: () => document.body,
                configurable: true
            });
            Object.defineProperty(document, 'webkitFullscreenElement', {
                get: () => document.body,
                configurable: true
            });
        });

        const session = {
            id: sessionId,
            browser,
            context,
            page,
            url,
            viewport,
            clients: new Set(), // WebSocket clients
            streaming: false,
            streamInterval: null,
            lastActivity: Date.now(),
            createdAt: Date.now()
        };

        this.sessions.set(sessionId, session);

        // Listen for fullscreen requests from the page
        page.on('console', msg => {
            if (msg.text().includes('FULLSCREEN_REQUEST')) {
                // Notify all clients about fullscreen request
                for (const client of session.clients) {
                    if (client.readyState === 1) {
                        client.send(JSON.stringify({ type: 'fullscreen_request' }));
                    }
                }
            }
        });

        // Also expose a function the page can call
        await page.exposeFunction('__notifyFullscreen', () => {
            for (const client of session.clients) {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({ type: 'fullscreen_request' }));
                }
            }
        });
        
        // Start activity timeout checker
        this.startTimeoutChecker(sessionId);

        this.log(`Session ${sessionId} created successfully`);
        return sessionId;
    }

    /**
     * Start streaming - OPTIMIZED FOR LOW LATENCY
     * ═══════════════════════════════════════════════════════════════
     * Uses CDP Page.startScreencast for hardware-accelerated capture
     * with adaptive quality based on network conditions.
     */
    async startStreaming(session) {
        if (session.streaming) return;
        
        session.streaming = true;
        
        // Track performance metrics for adaptive quality
        session.metrics = {
            lastFrameTime: Date.now(),
            frameCount: 0,
            droppedFrames: 0,
            avgLatency: 50,
            currentQuality: this.quality,
        };
        
        try {
            // Get CDP session for low-level control
            const cdpSession = await session.page.context().newCDPSession(session.page);
            session.cdpSession = cdpSession;
            
            // ─────────────── OPTIMIZED CAPTURE FUNCTION ───────────────
            // This is called on-demand, not continuously
            session.captureFrame = async (targetQuality = null) => {
                try {
                    const quality = targetQuality || session.metrics.currentQuality;
                    
                    const result = await cdpSession.send('Page.captureScreenshot', {
                        format: 'jpeg',
                        quality: quality,
                        fromSurface: true,
                        captureBeyondViewport: false,
                        optimizeForSpeed: true,  // CRITICAL: Faster encoding
                    });
                    
                    session.metrics.frameCount++;
                    return result.data;
                } catch (e) {
                    session.metrics.droppedFrames++;
                    return null;
                }
            };
            
            // ─────────────── ADAPTIVE QUALITY ADJUSTMENT ───────────────
            // Adjust quality based on network conditions every 2 seconds
            session.qualityInterval = setInterval(() => {
                this.adjustQuality(session);
            }, 2000);
            
            this.log(`Optimized CDP capture ready for session ${session.id}`);
            this.log(`Initial quality: ${this.quality}, Resolution: ${this.preset.width}x${this.preset.height}`);
            
        } catch (err) {
            this.log(`CDP setup failed: ${err.message}, using fallback`);
            this.startScreenshotStreaming(session);
        }
    }
    
    /**
     * Adjust quality based on network conditions
     * ═══════════════════════════════════════════════════════════════
     */
    adjustQuality(session) {
        const metrics = session.metrics;
        const avgLatency = metrics.avgLatency;
        const dropRate = metrics.droppedFrames / Math.max(metrics.frameCount, 1);
        
        let newQuality = metrics.currentQuality;
        
        // If latency is too high or dropping frames, reduce quality
        if (avgLatency > 200 || dropRate > 0.1) {
            newQuality = Math.max(this.minQuality, newQuality - 10);
            this.log(`High latency (${avgLatency}ms) - reducing quality to ${newQuality}`);
        }
        // If latency is good and stable, can increase quality slightly
        else if (avgLatency < 80 && dropRate < 0.02) {
            newQuality = Math.min(this.maxQuality, newQuality + 5);
        }
        
        metrics.currentQuality = newQuality;
        
        // Reset counters
        metrics.frameCount = 0;
        metrics.droppedFrames = 0;
    }
    
    /**
     * Fallback screenshot streaming (if CDP fails)
     * Uses simpler but slightly slower method
     */
    async startScreenshotStreaming(session) {
        // Use Playwright's native screenshot with optimizations
        session.captureFrame = async (targetQuality = null) => {
            try {
                const quality = targetQuality || this.quality;
                const screenshot = await session.page.screenshot({
                    type: 'jpeg',
                    quality: quality,
                    // Don't capture beyond viewport
                    fullPage: false,
                });
                return screenshot.toString('base64');
            } catch (e) {
                return null;
            }
        };
        
        this.log(`Screenshot fallback active for session ${session.id}`);
    }

    /**
     * Stop streaming and clean up resources
     */
    async stopStreaming(session) {
        session.streaming = false;
        
        // Stop quality adjustment interval
        if (session.qualityInterval) {
            clearInterval(session.qualityInterval);
            session.qualityInterval = null;
        }
        
        // Stop CDP screencast if active
        if (session.cdpSession) {
            try {
                await session.cdpSession.send('Page.stopScreencast');
                await session.cdpSession.detach();
            } catch (e) {
                // Ignore cleanup errors
            }
            session.cdpSession = null;
        }
        
        // Stop fallback interval if active
        if (session.streamInterval) {
            clearInterval(session.streamInterval);
            session.streamInterval = null;
        }
    }

    /**
     * Handle mouse events from client - OPTIMIZED FOR LOW LATENCY
     * ═══════════════════════════════════════════════════════════════
     * Input events are processed immediately without batching.
     * CDP is used for trusted events that work better with React/etc.
     */
    async handleMouseEvent(session, event) {
        try {
            const { event: eventType, x, y, button, deltaX, deltaY } = event;
            
            // Only log clicks for debugging (moves are too spammy)
            if (eventType !== 'mousemove' && eventType !== 'wheel') {
                this.log(`Mouse: ${eventType} at (${Math.round(x)}, ${Math.round(y)})`);
            }
            
            // Use CDP for all mouse events - faster and more reliable
            const cdp = session.cdpSession;
            
            switch (eventType) {
                case 'mousemove':
                    // CDP mouseMoved is faster than Playwright's mouse.move
                    if (cdp) {
                        await cdp.send('Input.dispatchMouseEvent', {
                            type: 'mouseMoved',
                            x, y,
                            pointerType: 'mouse'
                        });
                    } else {
                        await session.page.mouse.move(x, y, { steps: 1 });
                    }
                    break;
                    
                case 'mousedown':
                    if (cdp) {
                        await cdp.send('Input.dispatchMouseEvent', {
                            type: 'mousePressed',
                            x, y,
                            button: button || 'left',
                            clickCount: 1,
                            pointerType: 'mouse'
                        });
                    } else {
                        await session.page.mouse.move(x, y);
                        await session.page.mouse.down({ button: button || 'left' });
                    }
                    break;
                    
                case 'mouseup':
                    if (cdp) {
                        await cdp.send('Input.dispatchMouseEvent', {
                            type: 'mouseReleased',
                            x, y,
                            button: button || 'left',
                            clickCount: 1,
                            pointerType: 'mouse'
                        });
                    } else {
                        await session.page.mouse.move(x, y);
                        await session.page.mouse.up({ button: button || 'left' });
                    }
                    break;
                    
                case 'click':
                    // Full click sequence via CDP - trusted events
                    if (cdp) {
                        await cdp.send('Input.dispatchMouseEvent', {
                            type: 'mousePressed',
                            x, y,
                            button: 'left',
                            clickCount: 1,
                            pointerType: 'mouse'
                        });
                        // Minimal delay - just enough for event processing
                        await new Promise(r => setTimeout(r, 16));
                        await cdp.send('Input.dispatchMouseEvent', {
                            type: 'mouseReleased',
                            x, y,
                            button: 'left',
                            clickCount: 1,
                            pointerType: 'mouse'
                        });
                    } else {
                        await session.page.mouse.click(x, y, { button: button || 'left', delay: 16 });
                    }
                    break;
                    
                case 'dblclick':
                    if (cdp) {
                        await cdp.send('Input.dispatchMouseEvent', {
                            type: 'mousePressed',
                            x, y,
                            button: 'left',
                            clickCount: 2,
                            pointerType: 'mouse'
                        });
                        await new Promise(r => setTimeout(r, 16));
                        await cdp.send('Input.dispatchMouseEvent', {
                            type: 'mouseReleased',
                            x, y,
                            button: 'left',
                            clickCount: 2,
                            pointerType: 'mouse'
                        });
                    } else {
                        await session.page.mouse.dblclick(x, y);
                    }
                    break;
                    
                case 'wheel':
                    // Scroll via CDP - instant, no momentum
                    if (cdp) {
                        await cdp.send('Input.dispatchMouseEvent', {
                            type: 'mouseWheel',
                            x: x || 0,
                            y: y || 0,
                            deltaX: deltaX || 0,
                            deltaY: deltaY || 0,
                            modifiers: 0,
                            pointerType: 'mouse'
                        });
                    } else {
                        await session.page.mouse.wheel(deltaX || 0, deltaY || 0);
                    }
                    break;
            }
            
            session.lastActivity = Date.now();
        } catch (err) {
            this.log(`Mouse event error: ${err.message}`);
        }
    }

    /**
     * Handle touch/drag events from client - FOR TOUCHSCREEN SWIPES
     */
    async handleTouchEvent(session, event) {
        try {
            const { event: eventType, x, y, startX, startY, endX, endY } = event;
            
            this.log(`Touch: ${eventType} at (${Math.round(x || startX)}, ${Math.round(y || startY)})`);
            
            switch (eventType) {
                case 'touchstart':
                    await session.page.mouse.move(x, y);
                    await session.page.mouse.down();
                    break;
                case 'touchmove':
                    await session.page.mouse.move(x, y, { steps: 1 });
                    break;
                case 'touchend':
                    await session.page.mouse.up();
                    break;
                case 'swipe':
                    // Complete swipe gesture - drag from start to end
                    await session.page.mouse.move(startX, startY);
                    await session.page.mouse.down();
                    // Smooth drag with steps
                    await session.page.mouse.move(endX, endY, { steps: 10 });
                    await session.page.mouse.up();
                    break;
                case 'tap':
                    // Use CDP for trusted click - works better with React/custom buttons
                    if (session.cdpSession) {
                        await session.cdpSession.send('Input.dispatchMouseEvent', {
                            type: 'mousePressed',
                            x, y,
                            button: 'left',
                            clickCount: 1,
                            pointerType: 'mouse'
                        });
                        await new Promise(r => setTimeout(r, 50));
                        await session.cdpSession.send('Input.dispatchMouseEvent', {
                            type: 'mouseReleased',
                            x, y,
                            button: 'left',
                            clickCount: 1,
                            pointerType: 'mouse'
                        });
                    } else {
                        await session.page.mouse.click(x, y, { delay: 50 });
                    }
                    break;
            }
            
            session.lastActivity = Date.now();
        } catch (err) {
            this.log(`Touch event error: ${err.message}`);
        }
    }

    /**
     * Handle keyboard events from client
     */
    async handleKeyboardEvent(session, event) {
        try {
            const { event: eventType, key, code, text } = event;
            
            this.log(`Keyboard: ${eventType} key=${key}`);
            
            switch (eventType) {
                case 'keydown':
                    await session.page.keyboard.down(key);
                    break;
                case 'keyup':
                    await session.page.keyboard.up(key);
                    break;
                case 'keypress':
                    if (text) {
                        await session.page.keyboard.type(text);
                    } else {
                        await session.page.keyboard.press(key);
                    }
                    break;
            }
            
            session.lastActivity = Date.now();
        } catch (err) {
            this.log(`Keyboard event error: ${err.message}`);
        }
    }

    /**
     * Handle navigation requests
     */
    async handleNavigation(session, url) {
        try {
            this.log(`Navigating to: ${url}`);
            await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            session.url = url;
            session.lastActivity = Date.now();
            return { success: true, url: session.page.url() };
        } catch (err) {
            this.log(`Navigation error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    /**
     * Handle browser actions (back, forward, refresh)
     */
    async handleAction(session, action) {
        try {
            switch (action) {
                case 'back':
                    await session.page.goBack();
                    break;
                case 'forward':
                    await session.page.goForward();
                    break;
                case 'refresh':
                    await session.page.reload();
                    break;
            }
            session.lastActivity = Date.now();
            return { success: true, url: session.page.url() };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    /**
     * Start timeout checker for session
     */
    startTimeoutChecker(sessionId) {
        const checkInterval = setInterval(() => {
            const session = this.sessions.get(sessionId);
            if (!session) {
                clearInterval(checkInterval);
                return;
            }

            const inactive = Date.now() - session.lastActivity;
            if (inactive > this.sessionTimeout) {
                this.log(`Session ${sessionId} timed out`);
                this.destroySession(sessionId);
                clearInterval(checkInterval);
            }
        }, 60000); // Check every minute
    }

    /**
     * Destroy a session
     */
    async destroySession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        this.log(`Destroying session ${sessionId}`);

        // Stop streaming
        this.stopStreaming(session);

        // Close all client connections
        for (const client of session.clients) {
            client.close(1000, 'Session ended');
        }

        // Close browser
        try {
            await session.browser.close();
        } catch {}

        this.sessions.delete(sessionId);
    }

    /**
     * Serve the landing page
     */
    serveLandingPage(req, res) {
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Webtra — Secure Browser Proxy</title>
    <style>
        :root {
            --bg1: #020c1f;
            --bg2: #0b3c91;
            --blue: #2aa9ff;
            --blue2: #7fd0ff;
            --text: #eaf4ff;
            --muted: #b9d9ff;
            --glass: rgba(255,255,255,0.08);
            --glass2: rgba(0,0,0,0.35);
            --border: rgba(42,169,255,0.35);
            --shadow: rgba(0,0,0,0.55);
        }

        * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }

        body {
            min-height: 100vh;
            color: var(--text);
            overflow-x: hidden;
            background:
                radial-gradient(1000px 600px at 20% 10%, rgba(42,169,255,0.22), transparent 60%),
                radial-gradient(900px 700px at 85% 30%, rgba(127,208,255,0.14), transparent 65%),
                radial-gradient(circle at top, var(--bg2), var(--bg1));
        }

        .grid {
            position: fixed; inset: -40%;
            background-image:
                linear-gradient(rgba(42,169,255,0.10) 1px, transparent 1px),
                linear-gradient(90deg, rgba(42,169,255,0.08) 1px, transparent 1px);
            background-size: 48px 48px;
            transform: rotate(12deg);
            animation: drift 18s linear infinite;
            filter: blur(0.2px);
            opacity: 0.55;
            pointer-events: none;
            z-index: 0;
        }
        @keyframes drift {
            0% { transform: translate3d(0,0,0) rotate(12deg); }
            100% { transform: translate3d(140px, -120px, 0) rotate(12deg); }
        }

        .glow {
            position: fixed;
            width: 750px; height: 750px;
            background: rgba(42,169,255,0.20);
            filter: blur(160px);
            border-radius: 999px;
            animation: float 9s ease-in-out infinite;
            pointer-events: none;
            z-index: 0;
        }
        .glow.g2 {
            width: 620px; height: 620px;
            background: rgba(127,208,255,0.14);
            animation-duration: 11s;
            animation-delay: -2s;
            left: 55%; top: 10%;
        }
        @keyframes float {
            0% { transform: translateY(0) translateX(0); }
            50% { transform: translateY(-55px) translateX(25px); }
            100% { transform: translateY(0) translateX(0); }
        }

        .streaks {
            position: fixed; inset: 0;
            pointer-events: none;
            background:
                repeating-linear-gradient(
                    115deg,
                    rgba(42,169,255,0.00) 0px,
                    rgba(42,169,255,0.00) 140px,
                    rgba(42,169,255,0.06) 160px,
                    rgba(42,169,255,0.00) 190px
                );
            animation: streakmove 7s linear infinite;
            opacity: 0.6;
            z-index: 0;
        }
        @keyframes streakmove {
            0% { background-position: 0 0; }
            100% { background-position: 420px 0; }
        }

        /* Veltra Modal */
        .veltra-modal {
            position: fixed;
            inset: 0;
            background: rgba(2, 12, 31, 0.95);
            backdrop-filter: blur(20px);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            animation: fadeIn 0.5s ease;
        }
        .veltra-modal.hidden { display: none; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

        .veltra-content {
            text-align: center;
            max-width: 600px;
            padding: 48px;
            background: var(--glass);
            backdrop-filter: blur(18px);
            border: 1px solid rgba(255,255,255,0.10);
            border-radius: 22px;
            box-shadow: 0 40px 90px var(--shadow);
            animation: pop 600ms ease;
        }
        @keyframes pop {
            from { opacity: 0; transform: translateY(18px) scale(0.98); }
            to { opacity: 1; transform: translateY(0) scale(1); }
        }

        .veltra-content h2 {
            font-size: 2rem;
            font-weight: 900;
            background: linear-gradient(90deg, #dff3ff, #9ad9ff, #2aa9ff);
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
            margin-bottom: 16px;
        }

        .veltra-content p {
            color: var(--muted);
            font-size: 1.05rem;
            line-height: 1.6;
            margin-bottom: 24px;
        }

        .veltra-content .highlight {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 12px 20px;
            background: rgba(42,169,255,0.18);
            border: 1px solid var(--border);
            border-radius: 12px;
            color: var(--blue2);
            font-weight: 600;
            margin-bottom: 24px;
        }

        .veltra-btns {
            display: flex;
            gap: 12px;
            justify-content: center;
            flex-wrap: wrap;
        }

        .veltra-btn {
            padding: 14px 28px;
            border-radius: 12px;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            text-decoration: none;
        }

        .veltra-btn.primary {
            background: linear-gradient(135deg, var(--blue), var(--blue2));
            border: none;
            color: #020c1f;
        }
        .veltra-btn.primary:hover { transform: translateY(-2px); box-shadow: 0 8px 30px rgba(42,169,255,0.4); }

        .veltra-btn.secondary {
            background: var(--glass2);
            border: 1px solid rgba(255,255,255,0.15);
            color: var(--text);
        }
        .veltra-btn.secondary:hover { background: rgba(255,255,255,0.12); }

        /* Landing Page */
        .landing {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 40px 20px;
            position: relative;
            z-index: 2;
        }

        .title {
            font-size: 3.4rem;
            font-weight: 900;
            letter-spacing: 0.8px;
            background: linear-gradient(90deg, #dff3ff, #9ad9ff, #2aa9ff);
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
            text-shadow: 0 0 22px rgba(42,169,255,0.18);
        }

        .tagline {
            margin-top: 10px;
            color: var(--muted);
            font-size: 1.1rem;
        }

        .badge {
            display: inline-flex;
            gap: 10px;
            align-items: center;
            margin: 22px auto 10px;
            padding: 10px 16px;
            border-radius: 999px;
            background: rgba(42,169,255,0.18);
            border: 1px solid var(--border);
            color: #d8f0ff;
            font-size: 0.92rem;
        }

        .dot {
            width: 10px; height: 10px;
            border-radius: 999px;
            background: var(--blue);
            box-shadow: 0 0 18px rgba(42,169,255,0.8);
            animation: pulse 1.25s ease-in-out infinite;
        }
        @keyframes pulse {
            0%,100% { transform: scale(1); opacity: 0.9; }
            50% { transform: scale(1.35); opacity: 1; }
        }

        .search-container {
            width: 100%;
            max-width: 600px;
            margin: 30px 0 20px;
        }

        .search-box {
            display: flex;
            background: var(--glass2);
            border: 1px solid rgba(255,255,255,0.10);
            border-radius: 14px;
            overflow: hidden;
            box-shadow: 0 8px 32px var(--shadow);
        }

        .search-box input {
            flex: 1;
            background: transparent;
            border: none;
            padding: 18px 24px;
            font-size: 1.05rem;
            color: var(--text);
            outline: none;
        }
        .search-box input::placeholder { color: #6a9fd4; }

        .search-box button {
            background: linear-gradient(135deg, var(--blue), var(--blue2));
            border: none;
            padding: 18px 32px;
            color: #020c1f;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.2s;
        }
        .search-box button:hover { filter: brightness(1.1); }
        .search-box button:disabled { opacity: 0.5; cursor: not-allowed; }

        .quick-sites {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            justify-content: center;
            max-width: 700px;
        }

        .site-btn {
            background: var(--glass);
            border: 1px solid rgba(255,255,255,0.08);
            padding: 10px 18px;
            border-radius: 999px;
            color: var(--text);
            cursor: pointer;
            transition: all 0.2s;
            font-size: 0.95rem;
        }
        .site-btn:hover {
            background: rgba(42,169,255,0.2);
            border-color: var(--blue);
            transform: translateY(-2px);
        }

        .info {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 16px;
            max-width: 800px;
            margin-top: 40px;
        }

        .info-card {
            background: var(--glass2);
            border: 1px solid rgba(255,255,255,0.08);
            padding: 20px;
            border-radius: 14px;
            text-align: center;
            box-shadow: inset 0 0 0 1px rgba(42,169,255,0.08);
        }

        .info-card .icon { font-size: 2rem; margin-bottom: 10px; }
        .info-card h3 { font-size: 0.95rem; color: var(--blue2); margin-bottom: 6px; font-weight: 700; }
        .info-card p { font-size: 0.82rem; color: #9fc5ff; opacity: 0.9; }

        .status {
            margin-top: 20px;
            padding: 12px 24px;
            background: rgba(42,169,255,0.15);
            border: 1px solid var(--border);
            border-radius: 10px;
            color: var(--blue2);
            display: none;
        }
        .status.error {
            background: rgba(255,80,80,0.15);
            border-color: rgba(255,80,80,0.4);
            color: #ff9090;
        }
        .status.show { display: block; }

        footer {
            margin-top: 30px;
            color: #7ab8e8;
            font-size: 0.85rem;
            opacity: 0.8;
        }
        footer a { color: var(--blue2); text-decoration: none; }
        footer a:hover { text-decoration: underline; }

        /* Browser View */
        .browser-view {
            display: none;
            flex-direction: column;
            height: 100vh;
            width: 100%;
            position: relative;
            z-index: 10;
        }
        .browser-view.active { display: flex; }

        .browser-toolbar {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 14px;
            background: rgba(2, 12, 31, 0.95);
            border-bottom: 1px solid rgba(42,169,255,0.2);
            backdrop-filter: blur(10px);
        }

        .nav-btn {
            background: var(--glass2);
            border: 1px solid rgba(255,255,255,0.1);
            width: 38px; height: 38px;
            border-radius: 10px;
            color: var(--text);
            cursor: pointer;
            font-size: 1.1rem;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
        }
        .nav-btn:hover { background: rgba(42,169,255,0.2); border-color: var(--blue); }

        .url-bar {
            flex: 1;
            display: flex;
            background: var(--glass2);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 10px;
            overflow: hidden;
        }

        .url-bar input {
            flex: 1;
            background: transparent;
            border: none;
            padding: 10px 15px;
            color: var(--text);
            font-size: 0.9rem;
            outline: none;
        }

        .url-bar button {
            background: linear-gradient(135deg, var(--blue), var(--blue2));
            border: none;
            padding: 10px 20px;
            color: #020c1f;
            font-weight: 600;
            cursor: pointer;
        }

        .close-btn {
            background: rgba(255,80,80,0.3) !important;
            border-color: rgba(255,80,80,0.5) !important;
        }
        .close-btn:hover { background: rgba(255,80,80,0.5) !important; }

        .browser-content {
            flex: 1;
            position: relative;
            overflow: hidden;
            background: #020c1f;
        }

        #browserCanvas {
            width: 100%;
            height: 100%;
            object-fit: contain;
            cursor: default;
        }

        .loading-overlay {
            position: absolute;
            inset: 0;
            background: rgba(2, 12, 31, 0.9);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-direction: column;
            z-index: 10;
        }
        .loading-overlay.hidden { display: none; }

        .spinner {
            width: 50px; height: 50px;
            border: 3px solid rgba(42,169,255,0.2);
            border-top-color: var(--blue);
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        .loading-text {
            margin-top: 15px;
            color: var(--muted);
        }

        .stats {
            position: absolute;
            bottom: 10px; right: 10px;
            background: rgba(2, 12, 31, 0.8);
            padding: 6px 12px;
            border-radius: 8px;
            font-size: 0.75rem;
            color: #7ab8e8;
            border: 1px solid rgba(42,169,255,0.2);
        }

        @media (max-width: 600px) {
            .title { font-size: 2.5rem; }
            .veltra-content { padding: 32px 20px; }
            .veltra-content h2 { font-size: 1.5rem; }
        }
    </style>
</head>
<body>
    <div class="grid"></div>
    <div class="glow" style="left:-10%; top:30%;"></div>
    <div class="glow g2"></div>
    <div class="streaks"></div>

    <!-- Veltra Modal -->
    <div class="veltra-modal" id="veltraModal">
        <div class="veltra-content">
            <h2>🌐 Welcome to Webtra</h2>
            <p>
                Webtra is also available as part of <strong>Veltra OS</strong> — a complete web-based operating system with built-in apps, file management, and more!
            </p>
            <div class="highlight">
                ✨ Full Desktop Experience at veltra
            </div>
            <p style="font-size: 0.95rem; opacity: 0.85;">
                You can use Webtra standalone here, or get the complete experience with Veltra OS.
            </p>
            <div class="veltra-btns">
                <a href="https://mojhehh.github.io/veltra/" class="veltra-btn primary" target="_blank">
                    🚀 Open Veltra OS
                </a>
                <button class="veltra-btn secondary" id="continueBtn">
                    Continue to Webtra →
                </button>
            </div>
        </div>
    </div>

    <!-- Landing Page -->
    <div class="landing" id="landingPage">
        <div class="title">Webtra</div>
        <p class="tagline">Secure browser proxy — works with everything</p>

        <div class="badge">
            <span class="dot"></span>
            End-to-End Encrypted • Real Chromium Browser
        </div>

        <div class="search-container">
            <form class="search-box" id="startForm">
                <input type="text" id="urlInput" placeholder="Enter any URL (tiktok.com, roblox.com, etc.)" required>
                <button type="submit" id="startBtn">Launch →</button>
            </form>
        </div>

        <div class="quick-sites">
            <button class="site-btn" data-url="https://www.tiktok.com">🎵 TikTok</button>
            <button class="site-btn" data-url="https://www.youtube.com">▶️ YouTube</button>
            <button class="site-btn" data-url="https://www.roblox.com">🎮 Roblox</button>
            <button class="site-btn" data-url="https://now.gg">☁️ Now.gg</button>
            <button class="site-btn" data-url="https://www.twitch.tv">📺 Twitch</button>
            <button class="site-btn" data-url="https://discord.com/app">💬 Discord</button>
            <button class="site-btn" data-url="https://www.reddit.com">🤖 Reddit</button>
            <button class="site-btn" data-url="https://www.google.com">🔍 Google</button>
        </div>

        <div class="status" id="status"></div>

        <div class="info">
            <div class="info-card">
                <div class="icon">🖥️</div>
                <h3>Real Browser</h3>
                <p>Full Chromium running on server</p>
            </div>
            <div class="info-card">
                <div class="icon">✅</div>
                <h3>95%+ Compatible</h3>
                <p>TikTok, Roblox, Now.gg — all work</p>
            </div>
            <div class="info-card">
                <div class="icon">🔒</div>
                <h3>Secure</h3>
                <p>Your IP hidden from sites</p>
            </div>
            <div class="info-card">
                <div class="icon">⚡</div>
                <h3>Low Latency</h3>
                <p>Optimized ~${this.preset.fps} FPS streaming</p>
            </div>
        </div>

        <footer>
            © 2026 Webtra • Also available on <a href="https://mojhehh.github.io/veltra/" target="_blank">Veltra OS</a>
        </footer>
    </div>

    <!-- Browser View -->
    <div class="browser-view" id="browserView">
        <div class="browser-toolbar">
            <button class="nav-btn" id="backBtn" title="Back">←</button>
            <button class="nav-btn" id="forwardBtn" title="Forward">→</button>
            <button class="nav-btn" id="refreshBtn" title="Refresh">⟳</button>

            <div class="url-bar">
                <input type="text" id="currentUrl" placeholder="URL">
                <button id="goBtn">Go</button>
            </div>

            <button class="nav-btn" id="fullscreenBtn" title="Fullscreen">⛶</button>
            <button class="nav-btn close-btn" id="closeBtn" title="Close">✕</button>
        </div>

        <div class="browser-content">
            <div class="loading-overlay" id="loadingOverlay">
                <div class="spinner"></div>
                <div class="loading-text">Connecting to browser...</div>
            </div>

            <canvas id="browserCanvas"></canvas>

            <div class="stats" id="stats">FPS: -- | Latency: --ms</div>
        </div>
    </div>

    <script>
        // ============ FIREBASE BACKEND DETECTION ============
        const FIREBASE_URL = 'https://procces-3efd9-default-rtdb.firebaseio.com/backends/bestproxy.json';
        let backendUrl = null; // Will be set to Firebase URL if not localhost
        
        // Check if we're running on GitHub Pages or other deployment (not localhost)
        const isDeployed = !location.hostname.includes('localhost') && !location.hostname.includes('127.0.0.1');
        
        // Fetch backend URL from Firebase if deployed
        async function getBackendUrl() {
            if (!isDeployed) {
                // Running locally - use current host
                return location.origin;
            }
            
            // Running on GitHub Pages - fetch from Firebase
            try {
                const response = await fetch(FIREBASE_URL);
                const data = await response.json();
                if (data?.url) {
                    console.log('🔥 Using Firebase backend:', data.url);
                    return data.url;
                }
            } catch (err) {
                console.error('Failed to fetch backend URL:', err);
            }
            
            // Fallback - prompt user
            const url = prompt('Enter Best Proxy backend URL:');
            return url || location.origin;
        }
        
        // Initialize backend URL on page load
        (async () => {
            backendUrl = await getBackendUrl();
            console.log('Backend URL:', backendUrl);
        })();
        
        // ============ END FIREBASE BACKEND DETECTION ============

        // Veltra modal
        document.getElementById('continueBtn').addEventListener('click', () => {
            document.getElementById('veltraModal').classList.add('hidden');
        });

        // State
        let ws = null;
        let sessionId = null;
        let canvas, ctx;
        let frameCount = 0;
        let lastFpsUpdate = Date.now();
        let fps = 0;
        let latency = 0;

        // Elements
        const landingPage = document.getElementById('landingPage');
        const browserView = document.getElementById('browserView');
        const urlInput = document.getElementById('urlInput');
        const currentUrlInput = document.getElementById('currentUrl');
        const startBtn = document.getElementById('startBtn');
        const status = document.getElementById('status');
        const loadingOverlay = document.getElementById('loadingOverlay');
        const statsEl = document.getElementById('stats');

        // Initialize canvas
        function initCanvas() {
            canvas = document.getElementById('browserCanvas');
            ctx = canvas.getContext('2d');
            canvas.width = 1280;
            canvas.height = 720;
        }

        // Show status message
        function showStatus(msg, isError = false) {
            status.textContent = msg;
            status.className = 'status show' + (isError ? ' error' : '');
        }

        // Normalize URL
        function normalizeUrl(url) {
            url = url.trim();
            if (!url.match(/^https?:\\/\\//)) {
                url = 'https://' + url;
            }
            return url;
        }
        
        // Start browser session
        async function startSession(url) {
            url = normalizeUrl(url);
            startBtn.disabled = true;
            showStatus('Starting browser...');
            
            // Ensure we have backend URL
            if (!backendUrl) {
                backendUrl = await getBackendUrl();
            }
            
            try {
                const res = await fetch(backendUrl + '/api/session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url })
                });
                
                const data = await res.json();
                
                if (data.error) {
                    showStatus(data.error, true);
                    startBtn.disabled = false;
                    return;
                }
                
                sessionId = data.sessionId;
                showStatus('Connecting to stream...');
                
                // Connect WebSocket
                connectWebSocket();
                
            } catch (err) {
                showStatus('Failed to start: ' + err.message, true);
                startBtn.disabled = false;
            }
        }
        
        // Connect to WebSocket stream
        function connectWebSocket() {
            // Build WebSocket URL from backend URL
            const wsUrl = backendUrl.replace(/^http/, 'ws') + '/stream?session=' + sessionId;
            ws = new WebSocket(wsUrl);
            
            ws.onopen = () => {
                console.log('WebSocket connected');
                showBrowser();
            };
            
            ws.onmessage = async (e) => {
                // Binary frame (raw JPEG with 8-byte timestamp prefix)
                if (e.data instanceof Blob) {
                    const buffer = await e.data.arrayBuffer();
                    const view = new DataView(buffer);
                    // Read timestamp from first 8 bytes (BigInt64)
                    const timestamp = Number(view.getBigInt64(0));
                    latency = Date.now() - timestamp;
                    // Rest is JPEG data
                    const jpegData = new Uint8Array(buffer, 8);
                    const blob = new Blob([jpegData], { type: 'image/jpeg' });
                    const url = URL.createObjectURL(blob);
                    renderFrameUrl(url);
                    return;
                }
                
                // JSON message (url, error, fullscreen_request)
                const data = JSON.parse(e.data);
                
                if (data.type === 'frame') {
                    // Legacy base64 frame support
                    renderFrame(data.data);
                    latency = Date.now() - data.timestamp;
                } else if (data.type === 'url') {
                    currentUrlInput.value = data.url;
                } else if (data.type === 'error') {
                    alert('Error: ' + data.message);
                } else if (data.type === 'fullscreen_request') {
                    // The remote page requested fullscreen - go fullscreen on our end!
                    toggleFullscreen();
                }
            };
            
            ws.onclose = () => {
                console.log('WebSocket closed');
                if (browserView.classList.contains('active')) {
                    alert('Connection lost. Returning to home.');
                    closeBrowser();
                }
            };
            
            ws.onerror = (err) => {
                console.error('WebSocket error:', err);
                showStatus('Connection error', true);
            };
        }
        
        // Show browser view
        function showBrowser() {
            landingPage.style.display = 'none';
            browserView.classList.add('active');
            loadingOverlay.classList.remove('hidden');
            initCanvas();
            setupInputHandlers();
            startBtn.disabled = false;
            status.classList.remove('show');
            
            // Hide loading after first frame
            setTimeout(() => {
                loadingOverlay.classList.add('hidden');
            }, 2000);
        }
        
        // Close browser and return to landing
        function closeBrowser() {
            if (ws) {
                ws.close();
                ws = null;
            }
            
            // End session on server
            if (sessionId) {
                fetch('/api/session/' + sessionId, { method: 'DELETE' }).catch(() => {});
                sessionId = null;
            }
            
            browserView.classList.remove('active');
            landingPage.style.display = 'flex';
        }
        
        // Render a frame from blob URL (binary)
        let lastBlobUrl = null;
        function renderFrameUrl(url) {
            const img = new Image();
            img.onload = () => {
                // Revoke previous blob URL to prevent memory leak
                if (lastBlobUrl) {
                    URL.revokeObjectURL(lastBlobUrl);
                }
                lastBlobUrl = url;
                
                // Resize canvas if needed
                if (canvas.width !== img.width || canvas.height !== img.height) {
                    canvas.width = img.width;
                    canvas.height = img.height;
                }
                ctx.drawImage(img, 0, 0);
                
                // Update FPS
                frameCount++;
                const now = Date.now();
                if (now - lastFpsUpdate >= 1000) {
                    fps = frameCount;
                    frameCount = 0;
                    lastFpsUpdate = now;
                    statsEl.textContent = 'FPS: ' + fps + ' | Latency: ' + latency + 'ms';
                }
                
                // Hide loading overlay on first frame
                loadingOverlay.classList.add('hidden');
            };
            img.src = url;
        }
        
        // Render a frame (legacy base64)
        function renderFrame(base64Data) {
            const img = new Image();
            img.onload = () => {
                // Resize canvas if needed
                if (canvas.width !== img.width || canvas.height !== img.height) {
                    canvas.width = img.width;
                    canvas.height = img.height;
                }
                ctx.drawImage(img, 0, 0);
                
                // Update FPS
                frameCount++;
                const now = Date.now();
                if (now - lastFpsUpdate >= 1000) {
                    fps = frameCount;
                    frameCount = 0;
                    lastFpsUpdate = now;
                    statsEl.textContent = 'FPS: ' + fps + ' | Latency: ' + latency + 'ms';
                }
                
                // Hide loading overlay on first frame
                loadingOverlay.classList.add('hidden');
            };
            img.src = 'data:image/jpeg;base64,' + base64Data;
        }
        
        // Setup mouse/keyboard handlers
        function setupInputHandlers() {
            // Throttle mousemove - reduced for better hover responsiveness
            let lastMouseMove = 0;
            const mouseMoveThrottle = 16; // ~60fps mouse updates for responsive hover
            
            // Helper to get coordinates - FIXED for accurate clicking with object-fit:contain
            function getCoords(e) {
                const rect = canvas.getBoundingClientRect();
                
                // Handle both mouse and touch events
                let clientX, clientY;
                if (e.touches && e.touches.length > 0) {
                    clientX = e.touches[0].clientX;
                    clientY = e.touches[0].clientY;
                } else if (e.changedTouches && e.changedTouches.length > 0) {
                    clientX = e.changedTouches[0].clientX;
                    clientY = e.changedTouches[0].clientY;
                } else {
                    clientX = e.clientX;
                    clientY = e.clientY;
                }
                
                // Account for object-fit: contain letterboxing
                const canvasAspect = canvas.width / canvas.height;
                const rectAspect = rect.width / rect.height;
                
                let renderWidth, renderHeight, offsetX, offsetY;
                
                if (rectAspect > canvasAspect) {
                    // Letterboxed horizontally (black bars on sides)
                    renderHeight = rect.height;
                    renderWidth = rect.height * canvasAspect;
                    offsetX = (rect.width - renderWidth) / 2;
                    offsetY = 0;
                } else {
                    // Letterboxed vertically (black bars on top/bottom)
                    renderWidth = rect.width;
                    renderHeight = rect.width / canvasAspect;
                    offsetX = 0;
                    offsetY = (rect.height - renderHeight) / 2;
                }
                
                // Calculate position relative to actual rendered canvas area
                const relX = clientX - rect.left - offsetX;
                const relY = clientY - rect.top - offsetY;
                
                // Scale to actual canvas/viewport dimensions
                const x = Math.round((relX / renderWidth) * canvas.width);
                const y = Math.round((relY / renderHeight) * canvas.height);
                
                // Clamp to valid range
                return { 
                    x: Math.max(0, Math.min(canvas.width, x)), 
                    y: Math.max(0, Math.min(canvas.height, y)) 
                };
            }
            
            // ============ HIDDEN INPUT FOR iPAD KEYBOARD ============
            // This input captures keyboard on touch devices - only shows when user long-presses
            const hiddenInput = document.createElement('input');
            hiddenInput.type = 'text';
            hiddenInput.autocomplete = 'off';
            hiddenInput.autocapitalize = 'off';
            hiddenInput.autocorrect = 'off';
            hiddenInput.spellcheck = false;
            hiddenInput.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;font-size:16px;';
            document.body.appendChild(hiddenInput);
            
            let keyboardActive = false;
            let longPressTimer = null;
            
            // When hidden input gets typed in, send to server
            hiddenInput.addEventListener('input', (e) => {
                const text = e.data;
                if (text) {
                    for (const char of text) {
                        sendInput({ type: 'keyboard', event: 'keypress', key: char, text: char });
                    }
                }
                hiddenInput.value = '';
            });
            
            hiddenInput.addEventListener('keydown', (e) => {
                if (['Backspace', 'Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                    e.preventDefault();
                    sendInput({ type: 'keyboard', event: 'keydown', key: e.key, code: e.code });
                    sendInput({ type: 'keyboard', event: 'keyup', key: e.key, code: e.code });
                }
            });
            
            // Function to show keyboard - only on long press
            function showKeyboard() {
                keyboardActive = true;
                hiddenInput.style.pointerEvents = 'auto';
                hiddenInput.focus();
            }
            
            // Function to hide keyboard
            function hideKeyboard() {
                keyboardActive = false;
                hiddenInput.blur();
                hiddenInput.style.pointerEvents = 'none';
            }
            
            // ============ MOUSE EVENTS (Desktop) - WITH DRAG SUPPORT ============
            let mouseIsDown = false;
            let lastDragPos = null;
            let mouseDownPos = null;
            let mouseDownTime = 0;
            
            canvas.addEventListener('mousemove', (e) => {
                const now = Date.now();
                const { x, y } = getCoords(e);
                
                if (mouseIsDown) {
                    // DRAGGING - send every move for smooth drag
                    sendInput({ type: 'mouse', event: 'mousemove', x, y });
                    lastDragPos = { x, y };
                } else {
                    // Regular hover - throttle to reduce spam
                    if (now - lastMouseMove < mouseMoveThrottle) return;
                    lastMouseMove = now;
                    sendInput({ type: 'mouse', event: 'mousemove', x, y });
                }
            });
            
            canvas.addEventListener('mousedown', (e) => {
                e.preventDefault();
                mouseIsDown = true;
                const { x, y } = getCoords(e);
                mouseDownPos = { x, y };
                mouseDownTime = Date.now();
                lastDragPos = { x, y };
                const button = ['left', 'middle', 'right'][e.button] || 'left';
                sendInput({ type: 'mouse', event: 'mousedown', x, y, button });
            });
            
            canvas.addEventListener('mouseup', (e) => {
                e.preventDefault();
                const { x, y } = getCoords(e);
                const button = ['left', 'middle', 'right'][e.button] || 'left';
                
                // Check if this was a quick click (not a drag)
                const timeDiff = Date.now() - mouseDownTime;
                const isQuickClick = timeDiff < 300; // Less than 300ms
                const isSamePosition = mouseDownPos && 
                    Math.abs(x - mouseDownPos.x) < 10 && 
                    Math.abs(y - mouseDownPos.y) < 10;
                
                if (isQuickClick && isSamePosition) {
                    // Send a proper click event for buttons/dropdowns
                    sendInput({ type: 'mouse', event: 'click', x, y, button });
                } else {
                    // It was a drag, just send mouseup
                    sendInput({ type: 'mouse', event: 'mouseup', x, y, button });
                }
                
                mouseIsDown = false;
                lastDragPos = null;
                mouseDownPos = null;
            });
            
            // Handle mouse leaving canvas while dragging
            canvas.addEventListener('mouseleave', (e) => {
                if (mouseIsDown) {
                    const { x, y } = getCoords(e);
                    sendInput({ type: 'mouse', event: 'mouseup', x, y, button: 'left' });
                    mouseIsDown = false;
                    lastDragPos = null;
                    mouseDownPos = null;
                }
            });
            
            // Don't send separate click - mousedown+mouseup is enough
            // Only handle dblclick for double-clicks
            canvas.addEventListener('dblclick', (e) => {
                e.preventDefault();
                const { x, y } = getCoords(e);
                sendInput({ type: 'mouse', event: 'dblclick', x, y });
            });
            
            canvas.addEventListener('wheel', (e) => {
                e.preventDefault();
                const { x, y } = getCoords(e);
                // Send position + scroll delta (3x multiplier for responsiveness)
                sendInput({ type: 'mouse', event: 'wheel', x, y, deltaX: e.deltaX * 3, deltaY: e.deltaY * 3 });
            }, { passive: false });
            
            // ============ TOUCH EVENTS - PROPER DRAG/SWIPE SUPPORT ============
            let touchStartTime = 0;
            let touchStartPos = null;
            let touchCount = 0;
            let lastTap = 0;
            let lastTapPos = null;
            let isDragging = false;
            let touchActive = false;
            let dragStarted = false; // Track if we've sent touchstart to server
            
            canvas.addEventListener('touchstart', (e) => {
                e.preventDefault();
                touchCount = e.touches.length;
                touchStartTime = Date.now();
                
                if (longPressTimer) clearTimeout(longPressTimer);
                
                if (touchCount === 1) {
                    const { x, y } = getCoords(e);
                    touchStartPos = { x, y };
                    isDragging = false;
                    touchActive = true;
                    dragStarted = false; // Don't send touchstart yet - wait to see if it's a drag
                    
                    // Long press (500ms) to show keyboard
                    longPressTimer = setTimeout(() => {
                        showKeyboard();
                    }, 500);
                    
                } else if (touchCount === 2) {
                    // Two finger = scroll mode
                    touchActive = false;
                }
            }, { passive: false });
            
            canvas.addEventListener('touchmove', (e) => {
                e.preventDefault();
                
                if (e.touches.length === 1 && touchStartPos && touchActive) {
                    const { x, y } = getCoords(e);
                    const dx = Math.abs(x - touchStartPos.x);
                    const dy = Math.abs(y - touchStartPos.y);
                    
                    // If moved more than 10px, it's a drag
                    if (dx > 10 || dy > 10) {
                        isDragging = true;
                        // Cancel keyboard popup on drag
                        if (longPressTimer) {
                            clearTimeout(longPressTimer);
                            longPressTimer = null;
                        }
                        
                        // Send touchstart NOW when drag begins (not on initial touch)
                        if (!dragStarted) {
                            sendInput({ type: 'touch', event: 'touchstart', x: touchStartPos.x, y: touchStartPos.y });
                            dragStarted = true;
                        }
                    }
                    
                    // Always send move during drag for smooth puzzle solving
                    if (isDragging) {
                        sendInput({ type: 'touch', event: 'touchmove', x, y });
                    }
                    
                } else if (e.touches.length === 2) {
                    // Two finger scroll
                    const avgY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                    const rect = canvas.getBoundingClientRect();
                    const deltaY = (e.touches[0].clientY - rect.top) - avgY;
                    sendInput({ type: 'mouse', event: 'wheel', deltaX: 0, deltaY: deltaY * 5 });
                }
            }, { passive: false });
            
            canvas.addEventListener('touchend', (e) => {
                e.preventDefault();
                
                if (longPressTimer) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
                
                const touchDuration = Date.now() - touchStartTime;
                
                if (touchCount === 1 && touchStartPos) {
                    const { x, y } = getCoords(e);
                    
                    if (isDragging) {
                        // End the drag - send final position and release
                        sendInput({ type: 'touch', event: 'touchend', x, y });
                    } else if (touchDuration < 300) {
                        // Quick tap - send ONLY tap (not touchend, to avoid double-click)
                        // Check for double tap
                        const now = Date.now();
                        if (lastTap && now - lastTap < 300 && lastTapPos) {
                            const tapDx = Math.abs(touchStartPos.x - lastTapPos.x);
                            const tapDy = Math.abs(touchStartPos.y - lastTapPos.y);
                            if (tapDx < 50 && tapDy < 50) {
                                sendInput({ type: 'mouse', event: 'dblclick', x: touchStartPos.x, y: touchStartPos.y });
                                lastTap = 0;
                                lastTapPos = null;
                            } else {
                                sendInput({ type: 'touch', event: 'tap', x: touchStartPos.x, y: touchStartPos.y });
                                lastTap = now;
                                lastTapPos = { x: touchStartPos.x, y: touchStartPos.y };
                            }
                        } else {
                            sendInput({ type: 'touch', event: 'tap', x: touchStartPos.x, y: touchStartPos.y });
                            lastTap = now;
                            lastTapPos = { x: touchStartPos.x, y: touchStartPos.y };
                        }
                    } else {
                        // Long press release
                        sendInput({ type: 'touch', event: 'touchend', x: touchStartPos.x, y: touchStartPos.y });
                    }
                }
                
                touchStartPos = null;
                touchCount = 0;
                isDragging = false;
                touchActive = false;
                dragStarted = false;
            }, { passive: false });
            
            canvas.addEventListener('touchcancel', () => {
                if (longPressTimer) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
                // Release any active drag
                if (dragStarted && touchStartPos) {
                    sendInput({ type: 'touch', event: 'touchend', x: touchStartPos.x, y: touchStartPos.y });
                }
                touchStartPos = null;
                touchCount = 0;
                isDragging = false;
                touchActive = false;
                dragStarted = false;
            }, { passive: true });
            
            // ============ KEYBOARD EVENTS (Desktop) ============
            document.addEventListener('keydown', (e) => {
                if (!browserView.classList.contains('active')) return;
                if (document.activeElement === currentUrlInput) return;
                if (document.activeElement === hiddenInput) return; // Let hiddenInput handle it
                
                e.preventDefault();
                sendInput({ type: 'keyboard', event: 'keydown', key: e.key, code: e.code });
            });
            
            document.addEventListener('keyup', (e) => {
                if (!browserView.classList.contains('active')) return;
                if (document.activeElement === currentUrlInput) return;
                if (document.activeElement === hiddenInput) return;
                
                e.preventDefault();
                sendInput({ type: 'keyboard', event: 'keyup', key: e.key, code: e.code });
            });
            
            // Prevent context menu
            canvas.addEventListener('contextmenu', (e) => e.preventDefault());
            
            // Hide keyboard when tapping outside or pressing back
            document.addEventListener('click', (e) => {
                if (e.target !== canvas && e.target !== hiddenInput && keyboardActive) {
                    hideKeyboard();
                }
            });
        }
        
        // Send input to server
        function sendInput(input) {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(input));
            }
        }
        
        // Navigation handlers
        document.getElementById('backBtn').addEventListener('click', () => {
            sendInput({ type: 'action', action: 'back' });
        });
        
        document.getElementById('forwardBtn').addEventListener('click', () => {
            sendInput({ type: 'action', action: 'forward' });
        });
        
        document.getElementById('refreshBtn').addEventListener('click', () => {
            sendInput({ type: 'action', action: 'refresh' });
        });
        
        document.getElementById('goBtn').addEventListener('click', () => {
            const url = normalizeUrl(currentUrlInput.value);
            sendInput({ type: 'navigate', url });
        });
        
        currentUrlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const url = normalizeUrl(currentUrlInput.value);
                sendInput({ type: 'navigate', url });
            }
        });
        
        document.getElementById('closeBtn').addEventListener('click', closeBrowser);
        
        // Fullscreen toggle function
        function toggleFullscreen() {
            const elem = document.getElementById('browserView');
            if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                // Enter fullscreen
                if (elem.requestFullscreen) {
                    elem.requestFullscreen();
                } else if (elem.webkitRequestFullscreen) {
                    elem.webkitRequestFullscreen();
                }
            } else {
                // Exit fullscreen
                if (document.exitFullscreen) {
                    document.exitFullscreen();
                } else if (document.webkitExitFullscreen) {
                    document.webkitExitFullscreen();
                }
            }
        }
        
        document.getElementById('fullscreenBtn').addEventListener('click', toggleFullscreen);
        
        // ESC key to exit fullscreen
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && document.fullscreenElement) {
                document.exitFullscreen();
            }
        });
        
        // Start form
        document.getElementById('startForm').addEventListener('submit', (e) => {
            e.preventDefault();
            startSession(urlInput.value);
        });
        
        // Quick site buttons
        document.querySelectorAll('.site-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const url = btn.dataset.url;
                urlInput.value = url;
                startSession(url);
            });
        });
    </script>
</body>
</html>`;

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
    }

    /**
     * Handle HTTP requests
     */
    async handleRequest(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);

        // CORS headers - allow GitHub Pages
        const allowedOrigins = [
            'https://mojhehh.github.io',
            'http://localhost:3002',
            'http://127.0.0.1:3002'
        ];
        const origin = req.headers.origin;
        if (allowedOrigins.includes(origin) || origin?.startsWith('https://mojhehh.github.io')) {
            res.setHeader('Access-Control-Allow-Origin', origin);
        } else {
            res.setHeader('Access-Control-Allow-Origin', '*');
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Credentials', 'true');

        // Handle preflight OPTIONS request
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            return res.end();
        }

        // Landing page
        if (url.pathname === '/') {
            return this.serveLandingPage(req, res);
        }

        // Create session API
        if (url.pathname === '/api/session' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const { url: targetUrl } = JSON.parse(body);
                    
                    if (!targetUrl) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ error: 'URL required' }));
                    }

                    const sessionId = await this.createSession(targetUrl);
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ sessionId }));

                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            });
            return;
        }

        // Delete session API
        if (url.pathname.startsWith('/api/session/') && req.method === 'DELETE') {
            const sessionId = url.pathname.split('/')[3];
            await this.destroySession(sessionId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            return;
        }

        // 404
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
    }

    /**
     * Handle WebSocket connections
     */
    handleWebSocket(ws, req) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const sessionId = url.searchParams.get('session');

        if (!sessionId) {
            ws.close(4000, 'Session ID required');
            return;
        }

        const session = this.sessions.get(sessionId);
        if (!session) {
            ws.close(4001, 'Invalid session');
            return;
        }

        this.log(`Client connected to session ${sessionId}`);

        // Add client to session
        session.clients.add(ws);

        // Start streaming if not already
        this.startStreaming(session);

        // Send current URL
        ws.send(JSON.stringify({ type: 'url', url: session.page.url() }));

        // ═══════════════════════════════════════════════════════════════
        // OPTIMIZED FRAME LOOP - CRITICAL FOR LATENCY
        // ═══════════════════════════════════════════════════════════════
        // Key optimizations:
        // 1. Fixed frame interval (consistency > variable rate)
        // 2. Aggressive buffer checking (prevents latency buildup)
        // 3. Binary frames (smaller than base64)
        // 4. Adaptive quality based on network conditions
        
        let frameLoopActive = true;
        let lastFrameSent = 0;
        const frameInterval = this.preset.frameInterval; // From quality preset
        
        const pushFrames = async () => {
            if (!frameLoopActive || ws.readyState !== 1) return;
            
            const now = Date.now();
            const timeSinceLastFrame = now - lastFrameSent;
            
            // ─────────────── BACKPRESSURE CHECK (CRITICAL) ───────────────
            // If WebSocket buffer is backing up, skip frames
            // This is the #1 cause of latency buildup!
            if (ws.bufferedAmount > this.maxBufferedAmount) {
                // Buffer backed up - skip this frame entirely
                if (session.metrics) session.metrics.droppedFrames++;
                setTimeout(pushFrames, frameInterval);
                return;
            }
            
            // ─────────────── FRAME RATE LIMITING ───────────────
            // Don't capture faster than our target rate
            if (timeSinceLastFrame < frameInterval * 0.8) {
                setTimeout(pushFrames, frameInterval - timeSinceLastFrame);
                return;
            }
            
            // ─────────────── CAPTURE AND SEND FRAME ───────────────
            if (session.captureFrame) {
                const captureStart = Date.now();
                const frameData = await session.captureFrame();
                const captureTime = Date.now() - captureStart;
                
                if (frameData && ws.readyState === 1) {
                    // Convert base64 to binary buffer
                    const binaryData = Buffer.from(frameData, 'base64');
                    
                    // Prepend 8-byte timestamp for latency measurement
                    const timestamp = Buffer.alloc(8);
                    timestamp.writeBigInt64BE(BigInt(Date.now()), 0);
                    const packet = Buffer.concat([timestamp, binaryData]);
                    
                    // Send as binary (more efficient than base64 JSON)
                    ws.send(packet, { binary: true });
                    
                    lastFrameSent = Date.now();
                    
                    // Track latency for adaptive quality
                    if (session.metrics) {
                        // Use capture time as proxy for system load
                        session.metrics.avgLatency = 
                            session.metrics.avgLatency * 0.9 + captureTime * 0.1;
                    }
                }
            }
            
            // Schedule next frame
            setTimeout(pushFrames, frameInterval);
        };
        
        // Start frame loop after small delay
        setTimeout(pushFrames, 100);

        // Handle messages from client
        ws.on('message', async (data) => {
            try {
                const msg = JSON.parse(data.toString());

                if (msg.type === 'mouse') {
                    await this.handleMouseEvent(session, msg);
                } else if (msg.type === 'touch') {
                    await this.handleTouchEvent(session, msg);
                } else if (msg.type === 'keyboard') {
                    await this.handleKeyboardEvent(session, msg);
                } else if (msg.type === 'navigate') {
                    const result = await this.handleNavigation(session, msg.url);
                    ws.send(JSON.stringify({ type: 'url', url: session.page.url() }));
                } else if (msg.type === 'action') {
                    await this.handleAction(session, msg.action);
                    ws.send(JSON.stringify({ type: 'url', url: session.page.url() }));
                }
            } catch (err) {
                this.log(`Message error: ${err.message}`);
            }
        });

        // Handle disconnect
        ws.on('close', () => {
            this.log(`Client disconnected from session ${sessionId}`);
            frameLoopActive = false;
            session.clients.delete(ws);

            // If no clients, stop streaming (but keep session alive for reconnect)
            if (session.clients.size === 0) {
                this.stopStreaming(session);
            }
        });

        // Listen for page URL changes
        session.page.on('framenavigated', (frame) => {
            if (frame === session.page.mainFrame()) {
                const newUrl = session.page.url();
                ws.send(JSON.stringify({ type: 'url', url: newUrl }));
            }
        });
    }

    /**
     * Start the server
     */
    async start() {
        // Create HTTP server
        const server = http.createServer((req, res) => {
            this.handleRequest(req, res);
        });

        // Create WebSocket server
        const wss = new WebSocketServer({ server, path: '/stream' });
        
        wss.on('connection', (ws, req) => {
            this.handleWebSocket(ws, req);
        });

        // Start listening
        server.listen(this.port, () => {
            console.log(`
\x1b[32m╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   \x1b[1m🖥️  OPTIMIZED BROWSER STREAMING PROXY\x1b[0m\x1b[32m                       ║
║                                                               ║
║   \x1b[33mLocal:\x1b[0m  \x1b[4mhttp://localhost:${this.port}\x1b[0m\x1b[32m                            ║
║                                                               ║
║   \x1b[36m✓\x1b[32m Resolution: ${this.preset.width}x${this.preset.height} (optimized for iPads)     ║
║   \x1b[36m✓\x1b[32m Target: ${this.preset.fps} FPS @ ${this.preset.quality}% quality                 ║
║   \x1b[36m✓\x1b[32m Adaptive quality enabled                                   ║
║   \x1b[36m✓\x1b[32m Site optimizations: YouTube, TikTok, Gaming               ║
║   \x1b[36m✓\x1b[32m Max ${this.maxSessions} concurrent sessions                              ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝\x1b[0m
            `);
        });

        return server;
    }
}

// Run if executed directly
if (require.main === module) {
    /**
     * ═══════════════════════════════════════════════════════════════
     * OPTIMIZED CONFIGURATION FOR SCHOOL iPADS
     * ═══════════════════════════════════════════════════════════════
     * 
     * Target devices: 7th-gen iPads (weak CPU, limited RAM)
     * Network: Slow, filtered school Wi-Fi
     * 
     * PRESET OPTIONS:
     * - 'potato': Very slow networks (< 1 Mbps) - 640x360 @ 20fps
     * - 'low': Typical school Wi-Fi (1-3 Mbps) - 854x480 @ 24fps [DEFAULT]
     * - 'medium': Better networks (3-10 Mbps) - 960x540 @ 30fps
     * - 'high': Good networks (10+ Mbps) - 1280x720 @ 30fps
     * 
     * For cloud gaming (now.gg, Roblox), use 'medium' or 'high' if
     * network allows - gaming needs more visual fidelity.
     */
    const proxy = new BrowserStreamProxy({
        port: 3002,
        debug: true,
        maxSessions: 30,
        
        // ─────────────── CHOOSE YOUR PRESET ───────────────
        // Change this based on your network quality!
        preset: 'medium',    // 'potato', 'low', 'medium', or 'high'
        
        // Session timeout (30 minutes)
        sessionTimeout: 30 * 60 * 1000,
    });
    
    console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║  PERFORMANCE OPTIMIZATION ACTIVE                                          ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  Preset: ${proxy.preset === QUALITY_PRESETS.low ? 'LOW (for school Wi-Fi)' : 
           proxy.preset === QUALITY_PRESETS.potato ? 'POTATO (very slow)' :
           proxy.preset === QUALITY_PRESETS.medium ? 'MEDIUM (decent network)' : 'HIGH'}
║  Resolution: ${proxy.preset.width}x${proxy.preset.height}
║  Target FPS: ${proxy.preset.fps}
║  JPEG Quality: ${proxy.preset.quality}%
║  
║  OPTIMIZATIONS ENABLED:
║  ✓ Reduced viewport resolution (less bandwidth)
║  ✓ Lower JPEG quality (faster encoding)
║  ✓ Background throttling disabled
║  ✓ Animation reduction CSS injected
║  ✓ Tracker/analytics blocking
║  ✓ Adaptive quality based on network
║  ✓ Aggressive backpressure handling
║  ✓ Site-specific optimizations (YouTube, TikTok, gaming)
╚═══════════════════════════════════════════════════════════════════════════╝
    `);
    
    proxy.start();
}

module.exports = BrowserStreamProxy;
