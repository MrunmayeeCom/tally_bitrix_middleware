require('dotenv').config();

// Use getters so every access reads the CURRENT value
// This ensures company switching works without server restart
const config = {
  get host()    { return process.env.TALLY_HOST    || 'localhost'; },
  get port()    { return process.env.TALLY_PORT    || 9000; },
  get company() { return process.env.TALLY_COMPANY || 'Rajlaxmi Solutions Private Limited - (From 1-Apr-2016) - (from 1-Apr-2016)'; },

  setCompany(name) {
    process.env.TALLY_COMPANY = name;
  },

  getCompanies() {
    return (process.env.TALLY_COMPANIES || process.env.TALLY_COMPANY || '')
      .split(',')
      .filter(Boolean);
  }
};

module.exports = config;