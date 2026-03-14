const { getCompany } = require('../services/bitrixService');
const { mapCompanyToLedger } = require('../utils/mapper');
const { createLedger, alterLedger } = require('../services/tallyService');
const logger = require('../utils/logger');

async function processCompany(entityId, isUpdate = false) {
  try {
    logger.info(`Processing company — ${isUpdate ? 'UPDATE' : 'CREATE'}`, { entityId });

    const company = await getCompany(entityId);
    if (!company) throw new Error(`Company not found: ${entityId}`);

    const ledger = mapCompanyToLedger(company);
    logger.info('Company mapped', { ledgerName: ledger.ledgerName });

    if (isUpdate) {
      const result = await alterLedger(ledger);
      logger.info('Company ledger updated in Tally', { entityId, ledgerName: ledger.ledgerName });
      return { success: true, ledger, action: 'updated' };
    } else {
      const result = await createLedger(ledger);
      logger.info('Company ledger created in Tally', { entityId, ledgerName: ledger.ledgerName });
      return { success: true, ledger, action: 'created' };
    }

  } catch (error) {
    logger.error('Company processor failed', { entityId, message: error.message });
    throw error;
  }
}

module.exports = { processCompany };