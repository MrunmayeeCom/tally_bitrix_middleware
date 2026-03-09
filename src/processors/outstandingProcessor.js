const { getOutstanding } = require('../services/tallyService');
const { mapOutstandingToDeal } = require('../utils/mapper');
const { createDeal, updateDeal } = require('../services/bitrixService');
const { daysPending, formatAmount } = require('../utils/helpers');
const logger = require('../utils/logger');

async function processOutstanding() {
  try {
    logger.info('Outstanding sync started');

    // Step 1: Fetch outstanding bills from Tally (mock for now)
    const outstandingList = await getOutstanding();

    if (!outstandingList || outstandingList.length === 0) {
      logger.info('No outstanding bills found');
      return { success: true, processed: 0 };
    }

    logger.info(`Found ${outstandingList.length} outstanding bills`);

    let processed = 0;
    let failed    = 0;

    for (const outstanding of outstandingList) {
      try {
        // Step 2: Enrich with calculated fields
        outstanding.daysPending  = daysPending(outstanding.dueDate);
        outstanding.pendingAmount = formatAmount(outstanding.pendingAmount);
        outstanding.billAmount    = formatAmount(outstanding.billAmount);

        // Step 3: Map to Bitrix24 deal format
        const dealFields = mapOutstandingToDeal(outstanding);

        // Step 4: Create deal in Bitrix24
        const result = await createDeal(dealFields);

        logger.info('Outstanding bill synced to Bitrix24', {
          voucherNumber: outstanding.voucherNumber,
          partyName:     outstanding.partyName,
          pendingAmount: outstanding.pendingAmount,
          daysPending:   outstanding.daysPending,
          dealResult:    result
        });

        processed++;

      } catch (itemError) {
        logger.error('Failed to process outstanding bill', {
          voucherNumber: outstanding.voucherNumber,
          message:       itemError.message
        });
        failed++;
      }
    }

    logger.info('Outstanding sync completed', { processed, failed });
    return { success: true, processed, failed };

  } catch (error) {
    logger.error('Outstanding processor failed', { message: error.message });
    throw error;
  }
}

module.exports = { processOutstanding };