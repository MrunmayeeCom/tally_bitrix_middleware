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

// Track recently posted timeline comments to prevent duplicates
// within the same process run (e.g. dual scheduler ticks)
const _recentTimelineComments = new Map();

async function sendNotification(userId, message, dealId = null) {
  logger.info('Sending notification', { userId, dealId, message });

  // Timeline comment on the deal — visible to all, requires only CRM scope
  if (dealId) {
    // Dedup: skip if the same comment was posted for this deal in the last 60s
    const dedupeKey = `${dealId}:${message}`;
    const lastPosted = _recentTimelineComments.get(dedupeKey) || 0;
    if (Date.now() - lastPosted < 60000) {
      logger.warn('Timeline comment skipped — duplicate within 60s', { dealId });
      return;
    }
    _recentTimelineComments.set(dedupeKey, Date.now());
    setTimeout(() => _recentTimelineComments.delete(dedupeKey), 60000);

    try {
      const timelineText = message
        .replace(/\[b\](.*?)\[\/b\]/g, '$1')
        .replace(/[\u{1F300}-\u{1FFFF}]/gu, '')
        .replace(/[^\x20-\x7E\n]/g, '')
        .trim();
      await callBitrix('crm.timeline.comment.add', {
        fields: {
          ENTITY_TYPE: 'deal',
          ENTITY_ID:   dealId,
          COMMENT:     timelineText
        }
      });
      logger.info('Timeline comment posted', { dealId });
    } catch (e) {
      logger.warn('Timeline comment failed', { dealId, message: e.message });
    }
  }
}

// ── Invoices (Smart Invoice = entityTypeId 31) ──────────────────────────
async function getInvoice(id, invoiceType = 'smart') {
  logger.info(`Fetching invoice: ${id} | type: ${invoiceType}`);

  let item;

  if (invoiceType === 'legacy') {
    const data = await callBitrix('crm.invoice.get', { id });
    item = data.result || data;

    // Try to get party name from linked company
    if (item.UF_CRM_CRM_INVOICE_M_COMPANY_ID) {
      try {
        const co = await callBitrix('crm.company.get', { id: item.UF_CRM_CRM_INVOICE_M_COMPANY_ID });
        item.clientTitle = (co.result || co).TITLE || '';
        logger.info('Legacy invoice company enriched', { name: item.clientTitle });
      } catch (e) {
        logger.warn('Could not enrich legacy invoice company', { id });
      }
    }
    // Try contact if no company
    if (!item.clientTitle && item.UF_CRM_CRM_INVOICE_M_CONTACT_ID) {
      try {
        const ct = await callBitrix('crm.contact.get', { id: item.UF_CRM_CRM_INVOICE_M_CONTACT_ID });
        const c = ct.result || ct;
        item.clientTitle = `${c.NAME || ''} ${c.LAST_NAME || ''}`.trim();
        logger.info('Legacy invoice contact enriched', { name: item.clientTitle });
      } catch (e) {
        logger.warn('Could not enrich legacy invoice contact', { id });
      }
    }

  } else {
    const data = await callBitrix('crm.item.get', { 
      entityTypeId: 31,
      id 
    });
    item = data.result?.item || data.result || data;

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