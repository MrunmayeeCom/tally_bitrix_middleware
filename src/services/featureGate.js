let _features = {};
let _plan     = 'none';

function setFeatures(features, plan) {
  _features = features || {};
  _plan     = plan     || 'none';
}

function isEnabled(slug) {
  return _features[slug] === true;
}

function getLimit(slug, defaultValue = 0) {
  const v = _features[slug];
  return (v !== undefined && !isNaN(Number(v))) ? Number(v) : defaultValue;
}

function getPlan() { return _plan; }

function getAll() { return { ..._features }; }

// Starter fallback — only outstanding sync, hourly
function applyStarterFallback() {
  // Try to build fallback from registry cache — so even fallback
  // reflects whatever slugs exist in LMS without hardcoding
  try {
    const fs   = require('fs');
    const path = require('path');
    const cachePath = path.join(__dirname, '../../logs/feature-registry-cache.json');
    if (fs.existsSync(cachePath)) {
      const raw      = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const registry = raw.data || raw;
      if (registry?.features && Array.isArray(registry.features)) {
        _features = {};
        for (const f of registry.features) {
          if (!f.featureSlug) continue;
          // Starter defaults — only outstanding-sync and basic features on
          const starterOn = [
            'outstanding-sync', 'bill-as-deal', 'deal-field-mapping',
            'customer-details-mapping', 'duplicate-prevention',
            'pipeline-auto-setup', 'pipeline-stages',
            'sync-history', 'manual-trigger', 'email-support'
          ];
          if (f.featureType === 'limit') {
            // auto-sync default 60min, user-limit 1, company-limit 1
            _features[f.featureSlug] = f.featureSlug === 'auto-sync' ? 60
              : f.featureSlug === 'user-limit' ? 1
              : f.featureSlug === 'company-limit' ? 1
              : 0;
          } else {
            _features[f.featureSlug] = starterOn.includes(f.featureSlug);
          }
        }
        _plan = 'Starter (fallback)';
        return;
      }
    }
  } catch {}

  // Hard fallback only if registry cache doesn't exist yet
  _features = {
    'outstanding-sync': true,
    'bill-as-deal': true,
    'deal-field-mapping': true,
    'customer-details-mapping': true,
    'duplicate-prevention': true,
    'pipeline-auto-setup': true,
    'pipeline-stages': true,
    'sync-history': true,
    'manual-trigger': true,
    'auto-sync': 60,
    'user-limit': 1,
    'company-limit': 1,
    'contact-sync': false,
    'company-sync': false,
    'ledger-creation': false,
    'bidirectional-sync': false,
    'invoice-sync': false,
    'quotation-sync': false,
    'due-date-automation': false,
    'workflow-automation': false,
    'error-logging': false,
    'email-support': true,
    'priority-support': false,
  };
  _plan = 'Starter (fallback)';
}

module.exports = { setFeatures, isEnabled, getLimit, getPlan, getAll, applyStarterFallback };