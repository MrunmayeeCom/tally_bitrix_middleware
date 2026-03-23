let _features  = {};
let _plan      = 'none';
let _isActive  = false;  // true only when LMS confirms an active license

function setFeatures(features, plan, isActive = true) {
  if (!isActive || !features || !plan || plan === 'none') {
    // No active license — block everything
    _features = {};
    _plan     = 'none';
    _isActive = false;
    return;
  }
  _features = features;
  _plan     = plan;
  _isActive = true;
}

function isLicenseActive() { return _isActive; }

function isEnabled(slug) {
  return _isActive && _features[slug] === true;
}

function getLimit(slug, defaultValue = 0) {
  if (!_isActive) return defaultValue;
  const v = _features[slug];
  return (v !== undefined && !isNaN(Number(v))) ? Number(v) : defaultValue;
}

function getPlan() { return _plan; }

function getAll() { return _isActive ? { ..._features } : {}; }

// Called ONLY when LMS confirms license is expired mid-session.
// Never used as a default — all features come from LMS.
function applyNoLicenseLock() {
  _features = {};
  _plan     = 'none';
  _isActive = false;
}

// Keep name for backward compat with main.js calls, but behaviour changes:
// instead of loading hardcoded Starter features, it locks everything.
function applyStarterFallback() {
  applyNoLicenseLock();
}

module.exports = { setFeatures, isEnabled, getLimit, getPlan, getAll, isLicenseActive, applyStarterFallback, applyNoLicenseLock };