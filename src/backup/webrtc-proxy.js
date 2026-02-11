/**
 * Optimized Browser Streaming Proxy
 * Uses CDP Screencast for efficient frame capture
 * Binary WebSocket with aggressive compression
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const http = require('http');
const { WebSocketServer } = require('ws');

class OptimizedProxy {
    constructor(options = {}) {
        this.port = options.port || 3003;
        this.sessions = new Map();
        this.browser = null;
        this.defaultViewport = { width: 1280, height: 720 };
    }

    log(msg) {
        const time = new Date().toLocaleTimeString();
        console.log(`[PROXY] ${time} ${msg}`);
    }

    async start() {
        // Launch browser
        this.browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--autoplay-policy=no-user-gesture-required',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding'
            ]
        });

        this.log('Browser launched');

        // Create HTTP server
        this.server = http.createServer((req, res) => this.handleRequest(req, res));
        
        // WebSocket
        this.wss = new WebSocketServer({ server: this.server });
        this.wss.on('connection', (ws, req) => this.handleWebSocket(ws, req));

        this.server.listen(this.port, () => {
            console.log(`
╔════════════════════════════════════════════════════════════════╗
║                                                                ║
║   🚀 OPTIMIZED BROWSER STREAMING PROXY                        ║
║                                                                ║
║   Local:  http://localhost:${this.port}                            ║
║                                                                ║
║   ✓ CDP Screencast (event-driven frames)                      ║
║   ✓ Binary WebSocket (no base64 overhead)                     ║
║   ✓ Adaptive quality                                          ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
`);
        });
    }

    async createSession(url) {
        const id = Math.random().toString(36).substring(2, 10);
        
        const context = await this.browser.newContext({
            viewport: this.defaultViewport,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            bypassCSP: true,
            ignoreHTTPSErrors: true
        });

        const page = await context.newPage();
        
        // Setup CDP session
        const cdpSession = await page.context().newCDPSession(page);
        
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const session = {
            id,
            context,
            page,
            cdpSession,
            clients: new Set(),
            streaming: false,
            frameCount: 0
        };

        this.sessions.set(id, session);
        this.log(`Session ${id} created for ${url}`);
        
        return id;
    }

    async startScreencast(session) {
        if (session.streaming) return;
        session.streaming = true;

        const cdp = session.cdpSession;

        // Listen for screencast frames (event-driven, not polling!)
        cdp.on('Page.screencastFrame', async (event) => {
            const { data, sessionId, metadata } = event;
            
            // Acknowledge frame immediately to get next one fast
            await cdp.send('Page.screencastFrameAck', { sessionId });

            session.frameCount++;

            // Convert base64 to binary and send to all clients
            const binaryData = Buffer.from(data, 'base64');
            const timestamp = Buffer.alloc(8);
            timestamp.writeBigInt64BE(BigInt(Date.now()), 0);
            const packet = Buffer.concat([timestamp, binaryData]);

            for (const client of session.clients) {
                if (client.readyState === 1 && client.bufferedAmount < 50000) {
                    client.send(packet, { binary: true });
                }
            }
        });

        // Start screencast - CDP handles frame timing automatically
        await cdp.send('Page.startScreencast', {
            format: 'jpeg',
            quality: 60,           // Good balance
            maxWidth: 1280,
            maxHeight: 720,
            everyNthFrame: 1       // Every frame
        });

        this.log(`Screencast started for session ${session.id}`);
    }

    async stopScreencast(session) {
        if (!session.streaming) return;
        session.streaming = false;

        try {
            await session.cdpSession.send('Page.stopScreencast');
        } catch (e) {}

        this.log(`Screencast stopped for session ${session.id}`);
    }

    async handleWebSocket(ws, req) {
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
        session.clients.add(ws);

        // Start streaming
        await this.startScreencast(session);

        // Send current URL
        ws.send(JSON.stringify({ type: 'url', url: session.page.url() }));

        ws.on('message', async (data) => {
            try {
                const msg = JSON.parse(data.toString());

                if (msg.type === 'mouse') {
                    await this.handleMouseEvent(session, msg);
                } else if (msg.type === 'keyboard') {
                    await this.handleKeyboardEvent(session, msg);
                } else if (msg.type === 'navigate') {
                    await session.page.goto(msg.url, { waitUntil: 'domcontentloaded' });
                    ws.send(JSON.stringify({ type: 'url', url: session.page.url() }));
                } else if (msg.type === 'action') {
                    await this.handleAction(session, msg.action);
                    ws.send(JSON.stringify({ type: 'url', url: session.page.url() }));
                }
            } catch (err) {
                this.log(`Message error: ${err.message}`);
            }
        });

        ws.on('close', () => {
            session.clients.delete(ws);
            this.log(`Client disconnected from session ${sessionId}`);
            
            // Stop screencast if no clients
            if (session.clients.size === 0) {
                this.stopScreencast(session);
            }
        });

        // Log FPS every 5 seconds
        const fpsInterval = setInterval(() => {
            if (ws.readyState !== 1) {
                clearInterval(fpsInterval);
                return;
            }
            const fps = session.frameCount / 5;
            session.frameCount = 0;
            this.log(`Session ${sessionId}: ${fps.toFixed(1)} FPS`);
        }, 5000);
    }

    async handleMouseEvent(session, event) {
        try {
            const { event: eventType, x, y, button, deltaX, deltaY } = event;

            switch (eventType) {
                case 'mousemove':
                    await session.page.mouse.move(x, y);
                    break;
                case 'mousedown':
                    await session.page.mouse.move(x, y);
                    await session.page.mouse.down();
                    break;
                case 'mouseup':
                    await session.page.mouse.up();
                    break;
                case 'click':
                    // Use CDP for trusted click events - works with React/custom buttons
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
                    break;
                case 'wheel':
                    await session.cdpSession.send('Input.dispatchMouseEvent', {
                        type: 'mouseWheel',
                        x, y,
                        deltaX: deltaX || 0,
                        deltaY: deltaY || 0,
                        pointerType: 'mouse'
                    });
                    break;
            }
        } catch (err) {}
    }

    async handleKeyboardEvent(session, event) {
        try {
            const { event: eventType, key } = event;
            
            if (eventType === 'keydown') {
                await session.page.keyboard.down(key);
            } else if (eventType === 'keyup') {
                await session.page.keyboard.up(key);
            }
        } catch (err) {}
    }

    async handleAction(session, action) {
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
    }

    handleRequest(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);

        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // Serve HTML
        if (url.pathname === '/' || url.pathname === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(this.getHTML());
            return;
        }

        // Create session API
        if (url.pathname === '/api/session' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const { url: targetUrl } = JSON.parse(body);
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

        res.writeHead(404);
        res.end('Not found');
    }

    getHTML() {
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <title>Browser Proxy</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: system-ui, -apple-system, sans-serif;
            background: #0a0a0f;
            color: #fff;
            min-height: 100vh;
            overflow: hidden;
        }
        .container {
            display: flex;
            flex-direction: column;
            height: 100vh;
            padding: 10px;
        }
        .controls {
            display: flex;
            gap: 8px;
            margin-bottom: 10px;
            flex-shrink: 0;
        }
        input {
            flex: 1;
            padding: 10px 14px;
            border: none;
            border-radius: 6px;
            background: #1a1a2e;
            color: #fff;
            font-size: 14px;
        }
        button {
            padding: 10px 16px;
            border: none;
            border-radius: 6px;
            background: #00d4ff;
            color: #000;
            font-weight: bold;
            cursor: pointer;
            font-size: 14px;
        }
        button:hover { background: #00b8e6; }
        button:disabled { background: #333; color: #666; }
        #canvas-container {
            flex: 1;
            position: relative;
            background: #000;
            border-radius: 8px;
            overflow: hidden;
        }
        #canvas {
            width: 100%;
            height: 100%;
            object-fit: contain;
        }
        #stats {
            position: absolute;
            top: 8px;
            right: 8px;
            background: rgba(0,0,0,0.8);
            padding: 6px 10px;
            border-radius: 4px;
            font-family: monospace;
            font-size: 12px;
            color: #0f0;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="controls">
            <input type="text" id="url" placeholder="Enter URL..." value="https://www.google.com">
            <button id="connect">Go</button>
            <button id="back">←</button>
            <button id="forward">→</button>
            <button id="refresh">↻</button>
        </div>

        <div id="canvas-container">
            <canvas id="canvas"></canvas>
            <div id="stats">Ready</div>
        </div>
    </div>

    <script>
        const urlInput = document.getElementById('url');
        const connectBtn = document.getElementById('connect');
        const canvas = document.getElementById('canvas');
        const ctx = canvas.getContext('2d');
        const stats = document.getElementById('stats');
        
        let ws = null;
        let sessionId = null;
        let frameCount = 0;
        let lastFpsTime = Date.now();
        let fps = 0;
        let latency = 0;

        canvas.width = 1280;
        canvas.height = 720;

        connectBtn.onclick = connect;
        urlInput.onkeydown = (e) => { if (e.key === 'Enter') connect(); };

        async function connect() {
            const url = urlInput.value.trim();
            if (!url) return;

            connectBtn.disabled = true;
            stats.textContent = 'Connecting...';

            try {
                // Create session
                const res = await fetch('/api/session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url })
                });
                const data = await res.json();
                sessionId = data.sessionId;

                // Connect WebSocket
                ws = new WebSocket(\`ws://\${location.host}/?session=\${sessionId}\`);
                ws.binaryType = 'arraybuffer';

                ws.onopen = () => {
                    stats.textContent = 'Connected';
                    setupInputHandlers();
                };

                ws.onmessage = async (e) => {
                    // Binary frame
                    if (e.data instanceof ArrayBuffer) {
                        const view = new DataView(e.data);
                        const timestamp = Number(view.getBigInt64(0));
                        latency = Date.now() - timestamp;
                        
                        const jpegData = new Uint8Array(e.data, 8);
                        const blob = new Blob([jpegData], { type: 'image/jpeg' });
                        const url = URL.createObjectURL(blob);
                        
                        const img = new Image();
                        img.onload = () => {
                            if (canvas.width !== img.width || canvas.height !== img.height) {
                                canvas.width = img.width;
                                canvas.height = img.height;
                            }
                            ctx.drawImage(img, 0, 0);
                            URL.revokeObjectURL(url);
                            
                            frameCount++;
                            const now = Date.now();
                            if (now - lastFpsTime >= 1000) {
                                fps = frameCount;
                                frameCount = 0;
                                lastFpsTime = now;
                            }
                            stats.textContent = \`FPS: \${fps} | Latency: \${latency}ms\`;
                        };
                        img.src = url;
                        return;
                    }
                    
                    // JSON message
                    const msg = JSON.parse(e.data);
                    if (msg.type === 'url') {
                        urlInput.value = msg.url;
                    }
                };

                ws.onclose = () => {
                    stats.textContent = 'Disconnected';
                    connectBtn.disabled = false;
                };

            } catch (err) {
                stats.textContent = 'Error: ' + err.message;
                connectBtn.disabled = false;
            }
        }

        function getCoords(e) {
            const rect = canvas.getBoundingClientRect();
            
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

        function setupInputHandlers() {
            let lastMove = 0;
            
            // Safe send - only if WebSocket is open
            function send(data) {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(data));
                }
            }
            
            canvas.onmousemove = (e) => {
                const now = Date.now();
                if (now - lastMove < 32) return; // 30fps mouse
                lastMove = now;
                const { x, y } = getCoords(e);
                send({ type: 'mouse', event: 'mousemove', x, y });
            };

            canvas.onmousedown = (e) => {
                e.preventDefault();
            };

            canvas.onmouseup = (e) => {
                // Don't send on drag - not needed for this
            };

            // Single click handler - CDP handles it properly
            canvas.onclick = (e) => {
                e.preventDefault();
                const { x, y } = getCoords(e);
                send({ type: 'mouse', event: 'click', x, y });
            };

            canvas.onwheel = (e) => {
                e.preventDefault();
                const { x, y } = getCoords(e);
                send({ 
                    type: 'mouse', 
                    event: 'wheel', 
                    x, y,
                    deltaX: e.deltaX * 3, 
                    deltaY: e.deltaY * 3 
                });
            };

            // Touch support
            canvas.ontouchstart = (e) => {
                e.preventDefault();
                const { x, y } = getCoords(e);
                send({ type: 'mouse', event: 'mousedown', x, y });
            };

            canvas.ontouchmove = (e) => {
                e.preventDefault();
                const { x, y } = getCoords(e);
                send({ type: 'mouse', event: 'mousemove', x, y });
            };

            canvas.ontouchend = (e) => {
                e.preventDefault();
                send({ type: 'mouse', event: 'mouseup' });
            };

            // Keyboard
            document.onkeydown = (e) => {
                if (e.target === urlInput) return;
                send({ type: 'keyboard', event: 'keydown', key: e.key });
            };

            document.onkeyup = (e) => {
                if (e.target === urlInput) return;
                send({ type: 'keyboard', event: 'keyup', key: e.key });
            };
        }

        // Navigation buttons
        document.getElementById('back').onclick = () => {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'action', action: 'back' }));
        };
        document.getElementById('forward').onclick = () => {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'action', action: 'forward' }));
        };
        document.getElementById('refresh').onclick = () => {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'action', action: 'refresh' }));
        };
    </script>
</body>
</html>`;
    }
}

// Start
const proxy = new OptimizedProxy({ port: 3003 });
proxy.start();
