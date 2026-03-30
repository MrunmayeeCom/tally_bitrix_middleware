require('dotenv').config();
const express   = require('express');
const mongoose  = require('mongoose');
const cors      = require('cors');
const path      = require('path');

const webhookRoutes = require('./routes/webhook');
const eventsRoutes  = require('./routes/events');
const oauthRoutes   = require('./routes/oauth');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// OAuth (placeholder)
app.use('/bitrix/oauth', oauthRoutes);

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ success: false, message: err.message });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] TallySync Render Server running on port ${PORT}`);
  console.log(`[Server] APP_URL: ${process.env.APP_URL || 'not set'}`);
});