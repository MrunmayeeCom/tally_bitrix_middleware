const express = require('express');
const errorHandler = require('./middleware/errorHandler');
const healthRoutes = require('./routes/healthRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const { processOutstanding } = require('./processors/outstandingProcessor');
const logger = require('./utils/logger');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// routes
app.use('/health', healthRoutes);
app.use('/webhook', webhookRoutes);

// manual outstanding sync trigger
app.post('/sync/outstanding', async (req, res) => {
  try {
    logger.info('Manual outstanding sync triggered');
    const result = await processOutstanding();
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    logger.error('Manual outstanding sync failed', { message: error.message });
    res.status(500).json({ success: false, message: error.message });
  }
});

// error handler — must be last
app.use(errorHandler);

module.exports = app;