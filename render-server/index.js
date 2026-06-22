require('dotenv').config();
const express   = require('express');
const mongoose  = require('mongoose');
const cors      = require('cors');
const path      = require('path');

const webhookRoutes   = require('./routes/webhook');
const eventsRoutes    = require('./routes/events');
const oauthRoutes     = require('./routes/oauth');
const dashboardRoutes = require('./routes/dashboard');
const licenseRoutes   = require('./routes/license');
const purchaseRoutes  = require('./routes/purchase');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Static files (built by Vite) ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── MongoDB ───────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('[DB] MongoDB connected'))
  .catch(err => console.error('[DB] MongoDB connection error:', err.message));

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({
    success: true,
    status:  'OK',
    service: 'TallySync Render Server',
    timestamp: new Date().toISOString(),
  });
});

// Bitrix24 webhook receiver
app.use('/webhook', webhookRoutes);

// Client polling + registration endpoints
app.use('/api', eventsRoutes);

// OAuth
app.use('/bitrix/oauth', oauthRoutes);

// Dashboard — UI + data push/pull API (router handles path matching internally)
app.use('/dashboard', dashboardRoutes);

// License management
app.use('/api/license', licenseRoutes);

// Purchase (Razorpay order creation + verification)
app.use('/purchase', purchaseRoutes);

// TSX app — also accessible via /dashboard-ui
app.get('/dashboard-ui', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Legacy dashboard HTML — served inside iframe by Dashboard.tsx
app.get('/dashboard-legacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ success: false, message: err.message });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] TallySync Render Server running on port ${PORT}`);
  if (!process.env.APP_URL) {
    console.error('[Server] ⚠️  APP_URL is NOT SET — Bitrix24 webhook registration will fail. Add APP_URL to Render environment variables.');
  } else {
    console.log(`[Server] APP_URL: ${process.env.APP_URL}`);
    console.log(`[Server] Webhook endpoint: ${process.env.APP_URL}/webhook`);
  }
});