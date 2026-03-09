// ─────────────────────────────────────────
// Utility Helper Functions
// ─────────────────────────────────────────

// Format date to Tally format: YYYYMMDD
function formatTallyDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const yyyy = date.getFullYear();
  const mm   = String(date.getMonth() + 1).padStart(2, '0');
  const dd   = String(date.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

// Format date to readable: DD-MM-YYYY
function formatReadableDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const dd   = String(date.getDate()).padStart(2, '0');
  const mm   = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

// Calculate days between two dates
function daysBetween(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  const diff = Math.abs(d2 - d1);
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

// Calculate days pending from today
function daysPending(dueDateStr) {
  if (!dueDateStr) return 0;
  const today   = new Date();
  const dueDate = new Date(dueDateStr);
  const diff    = today - dueDate;
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
}

// Format amount to 2 decimal places
function formatAmount(amount) {
  return parseFloat(parseFloat(amount || 0).toFixed(2));
}

// Remove null/undefined/false/empty fields from object
function cleanObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([_, v]) => v !== null && v !== undefined && v !== '' && v !== false)
  );
}

// Generate unique sync ID
function generateSyncId(prefix = 'SYNC') {
  const timestamp = Date.now();
  const random    = Math.floor(Math.random() * 1000);
  return `${prefix}-${timestamp}-${random}`;
}

// Check if string is a valid date
function isValidDate(dateStr) {
  if (!dateStr) return false;
  const date = new Date(dateStr);
  return date instanceof Date && !isNaN(date);
}

// Safe JSON parse — returns null on failure
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// Truncate long strings for logging
function truncate(str, maxLength = 100) {
  if (!str) return '';
  return str.length > maxLength ? str.substring(0, maxLength) + '...' : str;
}

module.exports = {
  formatTallyDate,
  formatReadableDate,
  daysBetween,
  daysPending,
  formatAmount,
  cleanObject,
  generateSyncId,
  isValidDate,
  safeJsonParse,
  truncate
};