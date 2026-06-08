const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');

// In-memory store keyed by clientId
// { [clientId]: { stats, history, lastSync, connStatus, pushedAt } }
const store = {};

// GET /dashboard — serve the dashboard HTML
// Bitrix24 sends member_id in query — use it to find clientId from MongoDB
router.get('/', async (req, res) => {
  const htmlPath = path.join(__dirname, '..', 'public', 'dashboard.html');
  if (!fs.existsSync(htmlPath)) {
    return res.status(404).send('Dashboard not found.');
  }

  // If clientId already in query — serve directly
  if (req.query.clientId) {
    console.log('[Dashboard] Serving with clientId:', req.query.clientId);
    return res.sendFile(htmlPath);
  }

  // Bitrix24 passes member_id in query when opening the app
  const memberId = req.query.member_id || req.query.MEMBER_ID;
  if (memberId) {
    try {
      const OAuthToken = require('../models/OAuthToken');
      // Try exact memberId match first
      let token = await OAuthToken.findOne({ memberId });
      // Fallback: most recently updated token (covers cases where memberId wasn't saved)
      if (!token) {
        console.warn('[Dashboard] member_id not matched, falling back to latest token');
        token = await OAuthToken.findOne({}).sort({ updatedAt: -1 });
      }
      if (token) {
        console.log('[Dashboard] Redirecting member_id', memberId, '→ clientId', token.clientId);
        return res.redirect(`/dashboard?clientId=${token.clientId}`);
      }
    } catch (e) {
      console.error('[Dashboard] member_id lookup failed:', e.message);
    }
  }

  // Bitrix24 also passes DOMAIN in some flows — try matching by domain
  const domain = req.query.DOMAIN || req.query.domain;
  if (domain) {
    try {
      const OAuthToken = require('../models/OAuthToken');
      const token = await OAuthToken.findOne({ bitrixDomain: domain });
      if (token) {
        console.log('[Dashboard] Redirecting by domain', domain, '→ clientId', token.clientId);
        return res.redirect(`/dashboard?clientId=${token.clientId}`);
      }
    } catch (e) {
      console.error('[Dashboard] domain lookup failed:', e.message);
    }
  }

  // Last resort — redirect to most recently connected portal
  try {
    const OAuthToken = require('../models/OAuthToken');
    const latest = await OAuthToken.findOne({}).sort({ updatedAt: -1 });
    if (latest) {
      console.log('[Dashboard] No match found — falling back to latest token clientId:', latest.clientId);
      return res.redirect(`/dashboard?clientId=${latest.clientId}`);
    }
  } catch (e) {
    console.error('[Dashboard] latest token fallback failed:', e.message);
  }

  // Absolute fallback — serve dashboard anyway, it will show "agent offline"
  res.sendFile(htmlPath);
});

// POST /dashboard/push?clientId=xxx — agent pushes its status up
router.post('/push', (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ success: false, message: 'clientId required' });

  store[clientId] = {
    ...req.body,
    pushedAt: new Date().toISOString(),
  };

  console.log(`[Dashboard] Push received from clientId: ${clientId}`);
  res.json({ success: true });
});

// GET /dashboard/data?clientId=xxx — dashboard fetches latest data
router.get('/data', (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ success: false, message: 'clientId required' });

  const data = store[clientId];
  if (!data) return res.json({ success: false, message: 'No data yet — agent may be offline' });

  // Mark agent as offline if no push in last 5 minutes
  const pushedAt  = new Date(data.pushedAt);
  const agentLive = (Date.now() - pushedAt.getTime()) < 5 * 60 * 1000;

  // Pull licenseStatus from OAuthToken if available, fallback to pushed data
  let licenseStatus = data.licenseStatus || 'inactive';
  try {
    const OAuthToken = require('../models/OAuthToken');
    const token = await OAuthToken.findOne({ clientId }).lean();
    if (token?.licenseStatus) licenseStatus = token.licenseStatus;
  } catch {}

  res.json({ success: true, agentLive, licenseStatus, ...data });
});

module.exports = router;