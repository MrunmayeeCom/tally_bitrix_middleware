const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');

// In-memory store keyed by clientId
// { [clientId]: { stats, history, lastSync, connStatus, pushedAt } }
const store = {};

// GET /dashboard/info — resolve clientId from member_id or domain
// (kept for legacy redirect support)
router.get('/', async (req, res) => {
  const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
  if (!fs.existsSync(htmlPath)) {
    return res.status(404).send('Dashboard not found.');
  }

  // If clientId already in query — serve new TSX app
  if (req.query.clientId) {
    console.log('[Dashboard] Serving TSX app with clientId:', req.query.clientId);
    const tsxPath = path.join(__dirname, '..', 'public', 'index.html');
    return res.sendFile(tsxPath);
  }

  // No clientId — try to find the most recently active portal and redirect
  try {
    const OAuthToken = require('../models/OAuthToken');
    const latest = await OAuthToken.findOne({}).sort({ updatedAt: -1 }).lean();
    if (latest?.clientId) {
      console.log('[Dashboard] No clientId in query — redirecting to latest portal:', latest.clientId);
      return res.redirect(`/dashboard?clientId=${latest.clientId}`);
    }
  } catch (e) {
    console.error('[Dashboard] Latest token lookup failed:', e.message);
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

  // Absolute fallback — redirect to TSX app
  res.redirect('/dashboard');
});

// POST /dashboard/push?clientId=xxx — agent pushes its status up
router.post('/push', async (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ success: false, message: 'clientId required' });

  const payload = {
    ...req.body,
    pushedAt: new Date().toISOString(),
  };

  store[clientId] = payload;

  // Also store under the canonical OAuthToken clientId (bx-{memberId}) so dashboard
  // can find it regardless of which clientId the agent uses
  try {
    const OAuthToken = require('../models/OAuthToken');
    const domain = req.body?.domain || req.body?.bitrixDomain || '';
    let token = null;
    if (domain) {
      token = await OAuthToken.findOne({ bitrixDomain: domain }).lean();
    }
    if (!token) {
      token = await OAuthToken.findOne({}).sort({ updatedAt: -1 }).lean();
    }
    if (token && token.clientId && token.clientId !== clientId) {
      store[token.clientId] = payload;
      console.log(`[Dashboard] Push cross-stored under canonical clientId: ${token.clientId}`);
    }
  } catch {}

  console.log(`[Dashboard] Push received from clientId: ${clientId}`);
  res.json({ success: true });
});

// GET /dashboard/data?clientId=xxx — dashboard fetches latest data
router.get('/data', async (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ success: false, message: 'clientId required' });

  const data = store[clientId];
  if (!data) {
    // Try to find by matching OAuthToken clientId → maybe agent uses different clientId
    try {
      const OAuthToken = require('../models/OAuthToken');
      const token = await OAuthToken.findOne({ clientId }).lean();
      if (!token) {
        // Try latest token as fallback
        const latest = await OAuthToken.findOne({}).sort({ updatedAt: -1 }).lean();
        if (latest && store[latest.clientId]) {
          const altData = store[latest.clientId];
          const pushedAt = new Date(altData.pushedAt);
          const agentLive = (Date.now() - pushedAt.getTime()) < 5 * 60 * 1000;
          let licenseStatus = altData.licenseStatus || 'inactive';
          let customerEmail = altData.customerEmail || '';
          let licenseId = altData.licenseId || '';
          let licensePlan = altData.licensePlan || '';
          if (latest.licenseStatus) licenseStatus = latest.licenseStatus;
          if (latest.customerEmail) customerEmail = latest.customerEmail;
          if (latest.licenseId) licenseId = latest.licenseId;
          if (latest.licensePlan) licensePlan = latest.licensePlan;
          return res.json({ success: true, agentLive, licenseStatus, customerEmail, licenseId, licensePlan, ...altData });
        }
      }
    } catch {}
    return res.json({ success: false, agentLive: false, message: 'No data yet — agent may be offline', licenseStatus: 'inactive' });
  }

  // Mark agent as offline if no push in last 5 minutes
  const pushedAt  = new Date(data.pushedAt);
  const agentLive = (Date.now() - pushedAt.getTime()) < 5 * 60 * 1000;

  // Pull licenseStatus + customerEmail from OAuthToken — source of truth
  let licenseStatus    = data.licenseStatus    || 'inactive';
  let customerEmail    = data.customerEmail    || '';
  let licenseId        = data.licenseId        || '';
  let licensePlan      = data.licensePlan      || '';
  try {
    const OAuthToken = require('../models/OAuthToken');
    const token = await OAuthToken.findOne({ clientId }).lean();
    if (token?.licenseStatus) licenseStatus = token.licenseStatus;
    if (token?.customerEmail) customerEmail  = token.customerEmail;
    if (token?.licenseId)     licenseId      = token.licenseId;
    if (token?.licensePlan)   licensePlan    = token.licensePlan;
  } catch {}

  res.json({ success: true, agentLive, licenseStatus, customerEmail, licenseId, licensePlan, ...data });
});

module.exports = router;