const { getOutstanding } = require('../services/tallyService');
const { mapOutstandingToDeal } = require('../utils/mapper');
const { createDeal, updateDeal, getDeals } = require('../services/bitrixService');
const { callBitrix } = require('../connectors/bitrixConnector');
const { getTallyPipelineCategoryId } = require('../services/pipelineService');
const { daysPending, formatAmount } = require('../utils/helpers');
const { recordSync } = require('../utils/syncHistory');
const logger = require('../utils/logger');


// Match a Tally party name to a Bitrix24 contact or company
async function findBitrixParty(partyName) {
  if (!partyName) return {};

  try {
    // Search contacts first
    const contactData = await callBitrix('crm.contact.list', {
      filter: { '%NAME': partyName },
      select: ['ID', 'NAME', 'LAST_NAME']
    });
    const contacts = contactData.result || contactData;
    if (contacts.length > 0) {
      logger.info('Matched party to contact', { partyName, contactId: contacts[0].ID });
      return { bitrixContactId: contacts[0].ID };
    }

    // Search companies
    const companyData = await callBitrix('crm.company.list', {
      filter: { '%TITLE': partyName },
      select: ['ID', 'TITLE']
    });
    const companies = companyData.result || companyData;
    if (companies.length > 0) {
      logger.info('Matched party to company', { partyName, companyId: companies[0].ID });
      return { bitrixCompanyId: companies[0].ID };
    }

  } catch (e) {
    logger.warn('Party name lookup failed', { partyName, message: e.message });
  }

  return {};
}

async function findExistingDeal(partyName, voucherNumber) {
  try {
    const categoryId = await getTallyPipelineCategoryId();
    const fullTitle = `${partyName} - ${voucherNumber}`;
    const data = await callBitrix('crm.deal.list', {
      filter: {
        TITLE:       fullTitle,
        CATEGORY_ID: categoryId
      },
      select: ['ID', 'TITLE']
    });
    const deals = data.result || [];
    if (deals.length > 0) {
      logger.info('Existing deal found', { dealId: deals[0].ID, title: fullTitle });
      return deals[0].ID;
    }
  } catch (e) {
    logger.warn('Existing deal lookup failed', { voucherNumber, message: e.message });
  }
  return null;
}

async function processOutstanding() {
  try {
    logger.info('Outstanding sync started');

    // Step 1: Fetch outstanding bills from Tally
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
        outstanding.daysPending   = daysPending(outstanding.dueDate);
        outstanding.pendingAmount = formatAmount(outstanding.pendingAmount);
        outstanding.billAmount    = formatAmount(outstanding.billAmount);

        // Step 2b: Match partyName to Bitrix24 contact/company
        const partyMatch = await findBitrixParty(outstanding.partyName);
        Object.assign(outstanding, partyMatch);

        // Step 3: Map to Bitrix24 deal format
        const dealFields = mapOutstandingToDeal(outstanding);

        // Step 4: Create or Update deal in Bitrix24
        const existingDealId = await findExistingDeal(outstanding.partyName, outstanding.voucherNumber);
        let result;
        let action;

        if (existingDealId) {
          result = await updateDeal(existingDealId, dealFields);
          action = 'updated';
        } else {
          result = await createDeal(dealFields);
          action = 'created';
        }

        logger.info(`Outstanding bill ${action} in Bitrix24`, {
          voucherNumber: outstanding.voucherNumber,
          partyName:     outstanding.partyName,
          pendingAmount: outstanding.pendingAmount,
          daysPending:   outstanding.daysPending,
          action,
          dealId:        existingDealId || result
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

    const syncResult = { success: true, processed, failed, trigger: 'scheduled' };
    recordSync(syncResult);
    logger.info('Outstanding sync completed', { processed, failed });
    return syncResult;

  } catch (error) {
    logger.error('Outstanding processor failed', { message: error.message });
    throw error;
  }
}

module.exports = { processOutstanding };