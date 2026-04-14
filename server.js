require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const fs         = require('fs');

const { verifyToken, verifyFirebaseToken } = require('./middleware/auth');
const accountRoutes    = require('./routes/accounts');
const processingRoutes = require('./routes/processing');
const { proxyRouter, statsRouter } = require('./routes/other');
const BotManager       = require('./botManager');

const app    = express();
const server = http.createServer(app);

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const io = new Server(server, {
  cors: { origin: FRONTEND_URL, methods: ['GET', 'POST'], credentials: true },
  pingInterval: 25000,
  pingTimeout:  60000,
});

const dataDir = process.env.DATA_DIR || './data';
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, standardHeaders: true }));

const botManager = new BotManager(io);
app.set('botManager', botManager);

app.use('/api/accounts',   verifyToken, accountRoutes);
app.use('/api/processing', verifyToken, processingRoutes);
app.use('/api/proxy',      verifyToken, proxyRouter);
app.use('/api/stats',      verifyToken, statsRouter);

app.get('/health', (req, res) =>
  res.json({ status: 'ok', uptime: process.uptime(), ...botManager.getServerStats() })
);

// Global error handler — catches any route that throws
app.use((err, req, res, next) => {
  console.error('Unhandled route error:', err.message);
  res.status(500).json({ error: err.message });
});

// ── Socket auth ────────────────────────────────────────────────────────────────
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('No token'));
    const decoded    = await verifyFirebaseToken(token);
    socket.userId    = decoded.uid;
    socket.userEmail = decoded.email;
    socket.tabId     = socket.handshake.query.tabId || 'default';
    next();
  } catch { next(new Error('Unauthorized')); }
});

io.on('connection', (socket) => {
  console.log(`🔌 ${socket.userEmail} [${socket.tabId}] connected`);

  let currentRoom = null;

  socket.on('subscribe:profile', (profileName) => {
    if (currentRoom) socket.leave(currentRoom);
    const room = `profile:${socket.userId}:${profileName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    socket.join(room);
    currentRoom = room;
  });

  socket.on('unsubscribe:profile', () => {
    if (currentRoom) { socket.leave(currentRoom); currentRoom = null; }
  });

  socket.on('disconnect', (reason) =>
    console.log(`🔌 ${socket.userEmail} disconnected: ${reason}`)
  );

  socket.on('error', (err) => {
    console.error(`Socket error [${socket.userEmail}]:`, err.message);
  });
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🎁 Pothli & Cashback Claimer Backend running on :${PORT}`);
  console.log(`🌐 Frontend: ${FRONTEND_URL}`);
  console.log(`📁 Data: ${path.resolve(dataDir)}\n`);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down...`);
  try { await botManager.shutdownAll(); } catch (_) {}
  server.close(() => { console.log('Server closed.'); process.exit(0); });
  setTimeout(() => process.exit(1), 10000); // force-exit after 10s
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Prevent crashes from unhandled promise rejections ─────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason?.message || reason);
  // DO NOT crash — log and continue
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
  // DO NOT crash unless it's truly fatal
});
