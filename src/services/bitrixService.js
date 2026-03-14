const { callBitrix } = require('../connectors/bitrixConnector');
const { getTallyPipelineCategoryId } = require('./pipelineService');
const logger = require('../utils/logger');

// ── Contacts ──────────────────────────────
async function getContact(id) {
  logger.info('Fetching contact:', id);
  const data = await callBitrix('crm.contact.get', { id });
  const contact = data.result || data;
  logger.info('Contact data fetched', { ID: contact.ID, NAME: contact.NAME });
  return contact;
}

async function getContacts() {
  logger.info('Fetching all contacts');
  const data = await callBitrix('crm.contact.list', {});
  return data.result || data;
}

// ── Companies ─────────────────────────────
async function getCompany(id) {
  logger.info('Fetching company:', id);
  const data = await callBitrix('crm.company.get', { id });
  const company = data.result || data;
  logger.info('Company data fetched', { ID: company.ID, TITLE: company.TITLE });
  return company;
}

async function getCompanies() {
  logger.info('Fetching all companies');
  const data = await callBitrix('crm.company.list', {});
  return data.result || data;
}

// ── Deals ─────────────────────────────────
async function createDeal(fields) {
  // Inject Tally pipeline category if available
  const categoryId = await getTallyPipelineCategoryId();
  if (categoryId) {
    fields.CATEGORY_ID = categoryId;
  }
  logger.info('Creating deal in Bitrix24', { title: fields.TITLE, categoryId: categoryId || 'default' });
  const result = await callBitrix('crm.deal.add', { fields });
  logger.info('Deal created in Bitrix24', { dealId: result });
  return result;
}

async function updateDeal(id, fields) {
  logger.info('Updating deal in Bitrix24', { id });
  const result = await callBitrix('crm.deal.update', { id, fields });
  logger.info('Deal updated in Bitrix24', { id, result });
  return result;
}

async function getDeal(id) {
  logger.info('Fetching deal:', id);
  const data = await callBitrix('crm.deal.get', { id });
  return data.result || data;
}

async function getDeals(filter = {}) {
  logger.info('Fetching deals from Bitrix24');
  const data = await callBitrix('crm.deal.list', { filter });
  return data.result || data;
}

async function getDealsInPipeline(categoryId) {
  logger.info('Fetching all deals in pipeline', { categoryId });
  const allDeals = [];
  let start = 0;
  const PAGE = 50;

  while (true) {
    const data = await callBitrix('crm.deal.list', {
      filter: { CATEGORY_ID: categoryId },
      select: ['ID', 'TITLE', 'CLOSEDATE', 'STAGE_ID', 'ASSIGNED_BY_ID', 'OPPORTUNITY'],
      start
    });
    const page = data.result || [];
    allDeals.push(...page);

    // Bitrix24 returns `next` when more pages exist
    if (data.next && page.length === PAGE) {
      start = data.next;
    } else {
      break;
    }
  }

  logger.info(`Fetched ${allDeals.length} deals from pipeline`, { categoryId });
  return allDeals;
}

async function getStages(categoryId) {
  logger.info('Fetching stages for pipeline', { categoryId });
  const data = await callBitrix('crm.dealcategory.stage.list', { id: categoryId });
  return data.result || [];
}

async function sendNotification(userId, message, dealId = null) {
  logger.info('Sending notification', { userId, dealId, message });

  // Real in-app push notification to the assigned user
  try {
    await callBitrix('im.notify.system.add', {
      USER_ID: userId,
      MESSAGE: message
    });
    logger.info('Push notification sent', { userId });
  } catch (e) {
    logger.warn('Push notification failed', { userId, message: e.message });
  }

  // CRM activity on the deal — visible in deal timeline
  if (dealId) {
    try {
      const cleanMessage = message.replace(/\[.*?\]/g, ''); // strip BBCode for plain text fields
      await callBitrix('crm.activity.add', {
        fields: {
          OWNER_TYPE_ID:  2,       // 2 = Deal
          OWNER_ID:       dealId,
          TYPE_ID:        2,       // 2 = generic activity
          SUBJECT:        cleanMessage.substring(0, 80),
          DESCRIPTION:    cleanMessage,
          RESPONSIBLE_ID: userId,
          COMPLETED:      'Y'
        }
      });
      logger.info('CRM activity added on deal', { dealId });
    } catch (e) {
      logger.warn('CRM activity add failed', { dealId, message: e.message });
    }
  }
}

// ── Invoices (Smart Invoice = entityTypeId 31) ──────────────────────────
async function getInvoice(id) {
  logger.info('Fetching invoice:', id);
  const data = await callBitrix('crm.item.get', { 
    entityTypeId: 31,
    id 
  });
  const item = data.result?.item || data.result || data;

  // Enrich partyName — fetch real contact/company name if linked
  if (!item.clientTitle && !item.CLIENT_TITLE) {
    if (item.contactId > 0) {
      try {
        const contactData = await callBitrix('crm.contact.get', { id: item.contactId });
        const c = contactData.result || contactData;
        item.clientTitle = `${c.NAME || ''} ${c.LAST_NAME || ''}`.trim();
        logger.info('Invoice contact enriched', { contactId: item.contactId, name: item.clientTitle });
      } catch (e) {
        logger.warn('Could not enrich invoice contact', { contactId: item.contactId });
      }
    } else if (item.companyId > 0) {
      try {
        const companyData = await callBitrix('crm.company.get', { id: item.companyId });
        const co = companyData.result || companyData;
        item.clientTitle = co.TITLE || '';
        logger.info('Invoice company enriched', { companyId: item.companyId, name: item.clientTitle });
      } catch (e) {
        logger.warn('Could not enrich invoice company', { companyId: item.companyId });
      }
    }
  }

  return item;
}

// ── Quotes (entityTypeId 7) ────────────────────────────────────────────
async function getQuote(id) {
  logger.info('Fetching quote:', id);
  const data = await callBitrix('crm.item.get', {
    entityTypeId: 7,
    id
  });
  const item = data.result?.item || data.result || data;

  // Enrich clientTitle — same pattern as invoice
  if (!item.clientTitle && !item.CLIENT_TITLE) {
    if (item.contactId > 0) {
      try {
        const contactData = await callBitrix('crm.contact.get', { id: item.contactId });
        const c = contactData.result || contactData;
        item.clientTitle = `${c.NAME || ''} ${c.LAST_NAME || ''}`.trim();
        logger.info('Quote contact enriched', { contactId: item.contactId, name: item.clientTitle });
      } catch (e) {
        logger.warn('Could not enrich quote contact', { contactId: item.contactId });
      }
    } else if (item.companyId > 0) {
      try {
        const companyData = await callBitrix('crm.company.get', { id: item.companyId });
        const co = companyData.result || companyData;
        item.clientTitle = co.TITLE || '';
        logger.info('Quote company enriched', { companyId: item.companyId, name: item.clientTitle });
      } catch (e) {
        logger.warn('Could not enrich quote company', { companyId: item.companyId });
      }
    }
  }

  return item;
}

// ── Pipeline ──────────────────────────────
async function getPipelines() {
  logger.info('Fetching pipelines from Bitrix24');
  const data = await callBitrix('crm.category.list', { entityTypeId: 2 });
  return data.result?.categories || data.result || [];
}

module.exports = {
  getContact,
  getContacts,
  getCompany,
  getCompanies,
  createDeal,
  updateDeal,
  getDeal,
  getDeals,
  getDealsInPipeline,
  getStages,
  sendNotification,
  getInvoice,
  getQuote,
  getPipelines
};