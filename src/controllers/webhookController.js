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
        await processInvoice(entityId, isUpdate);
        break;

      case 'ONCRMQUOTEADD':
      case 'ONCRMQUOTEUPDATE':
        await processQuotation({ entityId, isUpdate });
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