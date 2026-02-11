const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

const app = express();
const PORT = 3000;

// Store browser instances per session
const sessions = new Map();

app.use(express.static('public'));
app.use(express.json());

// Create a new browser session for a user
app.post('/api/session/create', async (req, res) => {
  try {
    const sessionId = Math.random().toString(36).substring(2, 15);
    
    // Launch browser in headed mode (visible on X11 display)
    const browser = await chromium.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--window-size=1280,720',
        '--window-position=0,0'
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();
    
    sessions.set(sessionId, { browser, context, page, createdAt: Date.now() });

    console.log(`Session created: ${sessionId}`);
    res.json({ sessionId, success: true });
  } catch (error) {
    console.error('Failed to create session:', error);
    res.status(500).json({ error: error.message });
  }
});

// Navigate to a URL
app.post('/api/session/:sessionId/navigate', async (req, res) => {
  const { sessionId } = req.params;
  const { url } = req.body;

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    res.json({ success: true, url: session.page.url() });
  } catch (error) {
    console.error('Navigation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Close a session
app.post('/api/session/:sessionId/close', async (req, res) => {
  const { sessionId } = req.params;
  
  const session = sessions.get(sessionId);
  if (session) {
    try {
      await session.browser.close();
      sessions.delete(sessionId);
      console.log(`Session closed: ${sessionId}`);
    } catch (e) {
      console.error('Error closing session:', e);
    }
  }
  
  res.json({ success: true });
});

// Get session info
app.get('/api/session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    sessionId,
    url: session.page.url(),
    createdAt: session.createdAt
  });
});

// Cleanup old sessions periodically (30 min timeout)
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.createdAt > 30 * 60 * 1000) {
      session.browser.close().catch(() => {});
      sessions.delete(sessionId);
      console.log(`Session expired: ${sessionId}`);
    }
  }
}, 60000);

app.listen(PORT, () => {
  console.log(`Playwright noVNC server running on port ${PORT}`);
  console.log(`noVNC viewer available at http://localhost:6080/vnc.html`);
});
