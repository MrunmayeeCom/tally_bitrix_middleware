const express = require('express');
const router = express.Router();
const { handleWebhook } = require('../controllers/webhookController');
const { validateWebhook } = require('../middleware/validationMiddleware');

router.post('/', validateWebhook, handleWebhook);

module.exports = router;