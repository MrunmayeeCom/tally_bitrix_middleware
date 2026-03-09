const { getContact } = require('../services/bitrixService');
const { mapContactToLedger } = require('../utils/mapper');
const { createLedger } = require('../services/tallyService');
const logger = require('../utils/logger');

async function processContact(entityId) {
  try {
    logger.info('Processing contact', { entityId });

    // Step 1: Fetch contact from Bitrix24
    const contact = await getContact(entityId);
    if (!contact) throw new Error(`Contact not found: ${entityId}`);

    // Step 2: Map to Tally ledger format
    const ledger = mapContactToLedger(contact);
    logger.info('Contact mapped', { ledgerName: ledger.ledgerName });

    // Step 3: Create ledger in Tally
    const result = await createLedger(ledger);
    logger.info('Contact processor completed', {
      entityId,
      ledgerName: ledger.ledgerName,
      success: result.success
    });

    return { success: true, ledger };

  } catch (error) {
    logger.error('Contact processor failed', {
      entityId,
      message: error.message
    });
    throw error;
  }
}

module.exports = { processContact };