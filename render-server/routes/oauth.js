const express = require('express');
const router  = express.Router();

// Placeholder — will be completed when Bitrix24 vendor credentials available

// GET /bitrix/oauth/callback
router.get('/callback', async (req, res) => {
  res.send(`
    <html><body style="font-family:Arial;text-align:center;padding:40px">
      <h2>⚠️ OAuth Not Configured Yet</h2>
      <p>Bitrix24 vendor credentials pending.</p>
    </body></html>
  `);
});

module.exports = router;