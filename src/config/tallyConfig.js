require('dotenv').config();

const config = {
  host:    process.env.TALLY_HOST    || 'localhost',
  port:    process.env.TALLY_PORT    || 9000,
  company: process.env.TALLY_COMPANY || 'Test Company',
};

// Allow runtime company switching without restarting the server
// Called from /api/companies/switch endpoint
config.setCompany = function(name) {
  config.company = name;
  process.env.TALLY_COMPANY = name;
};

config.getCompanies = function() {
  return (process.env.TALLY_COMPANIES || process.env.TALLY_COMPANY || '')
    .split(',')
    .filter(Boolean);
};

module.exports = config;