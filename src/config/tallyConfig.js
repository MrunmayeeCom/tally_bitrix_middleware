require('dotenv').config();

module.exports = {
  host: process.env.TALLY_HOST || 'localhost',
  port: process.env.TALLY_PORT || 9000,
  company: process.env.TALLY_COMPANY || 'Test Company'
};