const { getContact } = require('../services/bitrixService');
const { mapContactToLedger } = require('../utils/mapper');
const { createLedger, alterLedger } = require('../services/tallyService');
const logger = require('../utils/logger');

async function processContact(entityId, isUpdate = false) {
  try {
    logger.info(`Processing contact — ${isUpdate ? 'UPDATE' : 'CREATE'}`, { entityId });

    const contact = await getContact(entityId);
    if (!contact) throw new Error(`Contact not found: ${entityId}`);

    const ledger = mapContactToLedger(contact);
    logger.info('Contact mapped', { ledgerName: ledger.ledgerName });

    if (isUpdate) {
      // For updates: alter the existing ledger in Tally
      const result = await alterLedger(ledger);
      logger.info('Contact ledger updated in Tally', { entityId, ledgerName: ledger.ledgerName });
      return { success: true, ledger, action: 'updated' };
    } else {
      const result = await createLedger(ledger);
      logger.info('Contact ledger created in Tally', { entityId, ledgerName: ledger.ledgerName });
      return { success: true, ledger, action: 'created' };
    }

  } catch (error) {
    logger.error('Contact processor failed', { entityId, message: error.message });
    throw error;
  }
}

module.exports = { processContact };