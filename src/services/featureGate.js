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
  _features = {
    'outstanding-sync'        : true,
    'bill-as-deal'            : true,
    'deal-field-mapping'      : true,
    'customer-details-mapping': true,
    'duplicate-prevention'    : true,
    'pipeline-auto-setup'     : true,
    'pipeline-stages'         : true,
    'sync-history'            : true,
    'manual-trigger'          : true,
    'auto-sync'               : 60,   // 60 min interval
    'user-limit'              : 1,
    'company-limit'           : 1,
    'contact-sync'            : false,
    'company-sync'            : false,
    'ledger-creation'         : false,
    'bidirectional-sync'      : false,
    'invoice-sync'            : false,
    'quotation-sync'          : false,
    'due-date-automation'     : false,
    'workflow-automation'     : false,
    'error-logging'           : false,
    'email-support'           : true,
    'priority-support'        : false,
  };
  _plan = 'Starter (fallback)';
}

module.exports = { setFeatures, isEnabled, getLimit, getPlan, getAll, applyStarterFallback };