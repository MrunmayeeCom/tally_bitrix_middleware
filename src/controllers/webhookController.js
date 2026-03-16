const logger = require('../utils/logger');
const { processContact } = require('../processors/contactProcessor');
const { processCompany } = require('../processors/companyProcessor');
const { processInvoice } = require('../processors/invoiceProcessor');
const { processQuotation } = require('../processors/quotationProcessor');

async function handleWebhook(req, res) {
  try {
    const payload  = req.body;
    const event    = payload.event;
    const entityId = payload.data?.FIELDS?.ID;

    logger.info('Webhook received', { event, entityId });

    if (!event) {
      return res.status(400).json({ success: false, message: 'No event found' });
    }

    const isUpdate = event.includes('UPDATE');

    switch (event) {

      case 'ONCRMCONTACTADD':
      case 'ONCRMCONTACTUPDATE':
        await processContact(entityId, isUpdate);
        break;

      case 'ONCRMCOMPANYADD':
      case 'ONCRMCOMPANYUPDATE':
        await processCompany(entityId, isUpdate);
        break;

      case 'ONCRMINVOICEADD':
      case 'ONCRMINVOICEUPDATE':
      case 'ONCRMSMARTINVOICEADD':
      case 'ONCRMSMARTINVOICEUPDATE':
        await processInvoice(entityId, isUpdate);
        break;

      case 'ONCRMQUOTEADD':
      case 'ONCRMQUOTEUPDATE':
      case 'ONCRMSMARTPROCESSELEMENTADD':
      case 'ONCRMSMARTPROCESSELEMENTEDIT':
        // entityTypeId 7 = Quote, ignore other smart process types
        if (!payload.data?.FIELDS?.ENTITY_TYPE_ID || String(payload.data.FIELDS.ENTITY_TYPE_ID) === '7') {
          await processQuotation({ entityId, isUpdate });
        } else {
          logger.info('Smart process event ignored — not a Quote', { entityTypeId: payload.data?.FIELDS?.ENTITY_TYPE_ID });
        }
        break;

      case 'ONCRMCONTACTDELETE':
      case 'ONCRMCOMPANYDELETE':
        logger.warn(`CRM record deleted in Bitrix24 — Tally ledger NOT removed (manual cleanup required)`, { event, entityId });
        break;

      default:
        logger.warn(`Unhandled event: ${event}`);
    }

    res.status(200).json({ success: true, message: 'Webhook processed' });

  } catch (error) {
    logger.error('Webhook processing error', { message: error.message });
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

module.exports = { handleWebhook };