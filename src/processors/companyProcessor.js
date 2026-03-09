const { getCompany } = require('../services/bitrixService');
const { mapCompanyToLedger } = require('../utils/mapper');
const { createLedger } = require('../services/tallyService');
const logger = require('../utils/logger');

async function processCompany(entityId) {
  try {
    logger.info('Processing company', { entityId });

    // Step 1: Fetch company from Bitrix24
    const company = await getCompany(entityId);
    if (!company) throw new Error(`Company not found: ${entityId}`);

    // Step 2: Map to Tally ledger format
    const ledger = mapCompanyToLedger(company);
    logger.info('Company mapped', { ledgerName: ledger.ledgerName });

    // Step 3: Create ledger in Tally
    const result = await createLedger(ledger);
    logger.info('Company processor completed', {
      entityId,
      ledgerName: ledger.ledgerName,
      success: result.success
    });

    return { success: true, ledger };

  } catch (error) {
    logger.error('Company processor failed', {
      entityId,
      message: error.message
    });
    throw error;
  }
}

module.exports = { processCompany };