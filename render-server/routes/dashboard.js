const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');

// In-memory store keyed by clientId
// { [clientId]: { stats, history, lastSync, connStatus, pushedAt } }
const store = {};

// Trigger queue: clientId → [{ trigger, queuedAt }]
const triggerQueue = {};

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

// POST /dashboard/push?clientId=xxx — agent pushes its status up OR dashboard sends trigger
router.post('/push', async (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ success: false, message: 'clientId required' });

  // If this is a trigger command from the dashboard (not a status push from agent)
  if (req.body && req.body.trigger && !req.body.agentLive && !req.body.stats) {
    if (!triggerQueue[clientId]) triggerQueue[clientId] = [];
    triggerQueue[clientId].push({
      trigger: req.body.trigger,
      queuedAt: new Date().toISOString(),
    });
    console.log(`[Dashboard] Trigger queued for clientId: ${clientId} | trigger: ${req.body.trigger}`);
    return res.json({ success: true, queued: true });
  }

  const payload = {
    ...req.body,
    pushedAt: new Date().toISOString(),
  };

  // Always store under the incoming clientId first (fast path)
  store[clientId] = payload;

  // Resolve the canonical OAuthToken clientId (bx-{memberId}) for this portal.
  // Agent may push under a raw bitrixDomain string (e.g. "world.bitrix24.com") while
  // canonical clientId is still being resolved — handle that case explicitly.
  try {
    const OAuthToken = require('../models/OAuthToken');
    const email  = req.body?.customerEmail || '';
    const domain = req.body?.domain || req.body?.bitrixDomain || clientId || '';

    // Priority: exact clientId match → domain match (including when clientId IS the domain) → email match → latest
    let token = await OAuthToken.findOne({ clientId }).lean();
    if (!token && domain) token = await OAuthToken.findOne({ bitrixDomain: domain }).lean();
    if (!token && email)  token = await OAuthToken.findOne({ customerEmail: email }).lean();
    if (!token) token = await OAuthToken.findOne({}).sort({ updatedAt: -1 }).lean();

    if (token) {
      const canonicalId = token.clientId;
      const mongoId     = token._id?.toString();
      const tokenDomain = token.bitrixDomain;

      // Store under canonical memberId-based clientId (the one dashboard uses after OAuth login)
      if (canonicalId && canonicalId !== clientId) {
        store[canonicalId] = { ...payload };
        console.log(`[Dashboard] Cross-stored push: ${clientId} → canonical: ${canonicalId}`);
      }
      // Store under MongoDB _id (used by marketplace app iframe after login)
      if (mongoId && mongoId !== clientId) {
        store[mongoId] = { ...payload };
      }
      // Store under raw domain string (agent pushes under domain while clientId resolving)
      if (tokenDomain && tokenDomain !== clientId) {
        store[tokenDomain] = { ...payload };
        console.log(`[Dashboard] Cross-stored push: ${clientId} → domain key: ${tokenDomain}`);
      }

      // Persist latest license fields back to OAuthToken so they survive Render restarts
      const updateFields = {};
      if (req.body?.licenseStatus) updateFields.licenseStatus = req.body.licenseStatus;
      if (req.body?.licensePlan)   updateFields.licensePlan   = req.body.licensePlan;
      if (req.body?.customerEmail) updateFields.customerEmail = req.body.customerEmail;
      if (Object.keys(updateFields).length > 0) {
        await OAuthToken.findOneAndUpdate(
          { _id: token._id },
          { $set: updateFields }
        );
      }
    }
  } catch(e) {
    console.error('[Dashboard] cross-store/license update failed:', e.message);
  }

  console.log(`[Dashboard] Push received from clientId: ${clientId}`);
  res.json({ success: true });
});

// GET /dashboard/data?clientId=xxx — dashboard fetches latest data
// Also handle /dashboard/data POST (some Bitrix24 iframes POST instead of GET)
router.post('/data', async (req, res, next) => { req.query = { ...req.query, ...req.body }; next(); });
router.get('/data', async (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ success: false, message: 'clientId required' });

  const data = store[clientId];
  if (!data) {
    try {
      const OAuthToken = require('../models/OAuthToken');
      let token = await OAuthToken.findOne({ clientId }).lean();
      // clientId from marketplace login is the MongoDB _id of OAuthToken
      if (!token) {
        try { token = await OAuthToken.findById(clientId).lean(); } catch {}
      }
      if (token) {
        // Check store under all known keys for this token
        const altData = store[token.clientId] || store[token._id?.toString()];
        if (altData) {
          const pushedAt  = new Date(altData.pushedAt);
          const agentLive = (Date.now() - pushedAt.getTime()) < 5 * 60 * 1000;
          return res.json({
            success: true, agentLive,
            licenseStatus: token.licenseStatus || altData.licenseStatus || 'inactive',
            customerEmail: token.customerEmail || altData.customerEmail || '',
            licenseId:     token.licenseId     || altData.licenseId     || '',
            licensePlan:   token.licensePlan   || altData.licensePlan   || '',
            ...altData,
            history:   altData.history   || [],
            lastSync:  altData.lastSync  || null,
            overdue:   altData.overdue   || [],
            status:    altData.status    || {},
            companies: altData.companies || { companies: [], active: '' },
          });
        }
      }
      // Last resort — use latest token's store data
      const latest = await OAuthToken.findOne({}).sort({ updatedAt: -1 }).lean();
      if (latest) {
        const altData = store[latest.clientId] || store[latest._id?.toString()];
        if (altData) {
          const pushedAt  = new Date(altData.pushedAt);
          const agentLive = (Date.now() - pushedAt.getTime()) < 5 * 60 * 1000;
          return res.json({
            success: true, agentLive,
            licenseStatus: latest.licenseStatus || altData.licenseStatus || 'inactive',
            customerEmail: latest.customerEmail || altData.customerEmail || '',
            licenseId:     latest.licenseId     || altData.licenseId     || '',
            licensePlan:   latest.licensePlan   || altData.licensePlan   || '',
            ...altData,
            history:   altData.history   || [],
            lastSync:  altData.lastSync  || null,
            overdue:   altData.overdue   || [],
            status:    altData.status    || {},
            companies: altData.companies || { companies: [], active: '' },
          });
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

  // Merge any extra structured data pushed by agent
  const responseData = {
    success: true,
    agentLive,
    licenseStatus,
    customerEmail,
    licenseId,
    licensePlan,
    ...data,
    // Ensure these keys always exist even if agent hasn't pushed them yet
    history:    data.history    || [],
    lastSync:   data.lastSync   || null,
    overdue:    data.overdue    || [],
    status:     data.status     || {},
    companies:  data.companies  || { companies: [], active: '' },
  };
  res.json(responseData);
});

// GET /dashboard/triggers?clientId=xxx — agent polls for pending triggers
router.get('/triggers', (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ success: false, message: 'clientId required' });

  const pending = triggerQueue[clientId] || [];
  triggerQueue[clientId] = []; // clear after delivery
  res.json({ success: true, triggers: pending });
});

module.exports = router;