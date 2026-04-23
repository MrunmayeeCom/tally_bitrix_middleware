const logger = require('../utils/logger');
const { processContact } = require('../processors/contactProcessor');
const { processCompany } = require('../processors/companyProcessor');
const { processInvoice } = require('../processors/invoiceProcessor');
const { processQuotation } = require('../processors/quotationProcessor');
const featureGate = require('../services/featureGate');

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
      case 'ONCRMCONTACTUPDATE': {
        if (!featureGate.isEnabled('contact-sync')) {
          logger.info('contact-sync not enabled on current plan — skipping', { entityId });
          break;
        }
        if (!featureGate.isEnabled('ledger-creation')) {
          logger.info('ledger-creation not enabled on current plan — skipping Tally ledger write', { entityId });
          break;
        }
        const contactSource = payload.data?.FIELDS?.SOURCE_DESCRIPTION || '';
        if (contactSource === 'TALLY_SYNC') {
          logger.info('Skipping webhook — contact was auto-created by Tally sync, not a user action', { entityId });
          break;
        }
        await processContact(entityId, isUpdate);
        break;
      }

      case 'ONCRMCOMPANYADD':
      case 'ONCRMCOMPANYUPDATE': {
        if (!featureGate.isEnabled('company-sync')) {
          logger.info('company-sync not enabled on current plan — skipping', { entityId });
          break;
        }
        if (!featureGate.isEnabled('ledger-creation')) {
          logger.info('ledger-creation not enabled on current plan — skipping Tally ledger write', { entityId });
          break;
        }
        const companySource = payload.data?.FIELDS?.SOURCE_DESCRIPTION || '';
        if (companySource === 'TALLY_SYNC') {
          logger.info('Skipping webhook — company was auto-created by Tally sync, not a user action', { entityId });
          break;
        }
        await processCompany(entityId, isUpdate);
        break;
      }

      case 'ONCRMINVOICEADD':
      case 'ONCRMINVOICEUPDATE':
        if (!featureGate.isEnabled('invoice-sync')) {
          logger.info('invoice-sync not enabled on current plan — skipping', { entityId });
          break;
        }
        await processInvoice(entityId, isUpdate, 'legacy');
        break;

      case 'ONCRMSMARTINVOICEADD':
      case 'ONCRMSMARTINVOICEUPDATE':
        if (!featureGate.isEnabled('invoice-sync')) {
          logger.info('invoice-sync not enabled on current plan — skipping', { entityId });
          break;
        }
        await processInvoice(entityId, isUpdate, 'smart');
        break;

      case 'ONCRMQUOTEADD':
      case 'ONCRMQUOTEUPDATE':
      case 'ONCRMSMARTPROCESSELEMENTADD':
      case 'ONCRMSMARTPROCESSELEMENTEDIT': {
        const entityTypeId = payload.data?.FIELDS?.ENTITY_TYPE_ID || '7';
        logger.info('Quote/Estimate webhook received', { 
          event, 
          entityId, 
          entityTypeId 
        });
        
        if (!featureGate.isEnabled('quotation-sync')) {
          logger.info('quotation-sync not enabled on current plan — skipping', { entityId });
          break;
        }
        await processQuotation({ entityId, isUpdate: event === 'ONCRMQUOTEUPDATE' || event === 'ONCRMSMARTPROCESSELEMENTEDIT', entityTypeId });
        break;
      }

      case 'ONCRMDYNAMICITEMADD':
      case 'ONCRMDYNAMICITEMUPDATE': {
        if (!featureGate.isEnabled('invoice-sync')) {
          logger.info('invoice-sync not enabled — skipping dynamic item', { entityId });
          break;
        }
        // Skip invoices created by Tally sync — prevents double-voucher in Tally
        try {
          const itemData = await require('../connectors/bitrixConnector').callBitrix('crm.item.get', { entityTypeId: 31, id: entityId });
          const item = itemData.result?.item || itemData.result || {};
          const isTallyCreated = item.ufCrm_64E895A2E83B1 === 'Y'
            || (item.accountNumber && String(item.accountNumber).startsWith('BX-'))
            || item.sourceDescription === 'TALLY_SYNC';
          if (isTallyCreated) {
            logger.info('Skipping ONCRMDYNAMICITEMADD — invoice was created by Tally sync', { entityId });
            break;
          }
        } catch (_) {}
        await processInvoice(entityId, event === 'ONCRMDYNAMICITEMUPDATE', 'smart');
        break;
      }

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

// Called by eventPoller directly (no req/res)
async function handleWebhookPayload(payload) {
  const event    = payload.event;
  const entityId = payload.data?.FIELDS?.ID;

  logger.info('Webhook received via poller', { event, entityId });
  logger.info('[Poller] Feature gate state', {
    contactSync:   featureGate.isEnabled('contact-sync'),
    companySync:   featureGate.isEnabled('company-sync'),
    ledgerCreation:featureGate.isEnabled('ledger-creation'),
    licenseActive: featureGate.isLicenseActive(),
    plan:          featureGate.getPlan(),
  });

  if (!event) return;

  const isUpdate = event.includes('UPDATE');

  switch (event) {
    case 'ONCRMCONTACTADD':
    case 'ONCRMCONTACTUPDATE': {
      if (!featureGate.isEnabled('contact-sync')) break;
      if (!featureGate.isEnabled('ledger-creation')) break;
      const contactSource = payload.data?.FIELDS?.SOURCE_DESCRIPTION || '';
      if (contactSource === 'TALLY_SYNC') break;
      await processContact(entityId, isUpdate);
      break;
    }
    case 'ONCRMCOMPANYADD':
    case 'ONCRMCOMPANYUPDATE': {
      if (!featureGate.isEnabled('company-sync')) break;
      if (!featureGate.isEnabled('ledger-creation')) break;
      const companySource = payload.data?.FIELDS?.SOURCE_DESCRIPTION || '';
      if (companySource === 'TALLY_SYNC') break;
      await processCompany(entityId, isUpdate);
      break;
    }
    case 'ONCRMINVOICEADD':
    case 'ONCRMINVOICEUPDATE':
      if (!featureGate.isEnabled('invoice-sync')) break;
      await processInvoice(entityId, isUpdate, 'legacy');
      break;
    case 'ONCRMSMARTINVOICEADD':
    case 'ONCRMSMARTINVOICEUPDATE':
      if (!featureGate.isEnabled('invoice-sync')) break;
      await processInvoice(entityId, isUpdate, 'smart');
      break;
    case 'ONCRMQUOTEADD':
    case 'ONCRMQUOTEUPDATE':
      if (!featureGate.isEnabled('quotation-sync')) break;
      await processQuotation({ entityId, isUpdate });
      break;
    case 'ONCRMDYNAMICITEMADD':
    case 'ONCRMDYNAMICITEMUPDATE': {
      if (!featureGate.isEnabled('invoice-sync')) {
        logger.info('[Poller] invoice-sync not enabled — skipping dynamic item', { entityId });
        break;
      }
      // Skip invoices created by Tally sync itself — title starts with a known party
      // and was just created by itemInvoiceBuilder or tallyInvoiceProcessor.
      // We check by fetching the invoice title and seeing if it was synced from Tally.
      try {
        const { callBitrix: _cb } = require('../connectors/bitrixConnector');
        const itemData = await _cb('crm.item.get', { entityTypeId: 31, id: entityId });
        const item = itemData.result?.item || itemData.result || {};
        const isTallyCreated = item.ufCrm_64E895A2E83B1 === 'Y' // UF_TALLY_SYNCED
          || (item.accountNumber && String(item.accountNumber).startsWith('BX-'))
          || item.sourceDescription === 'TALLY_SYNC';
        if (isTallyCreated) {
          logger.info('[Poller] Skipping ONCRMDYNAMICITEMADD — invoice was created by Tally sync', { entityId });
          break;
        }
      } catch (_) {
        // If check fails, proceed normally — better to process than miss a real event
      }
      await processInvoice(entityId, event === 'ONCRMDYNAMICITEMUPDATE', 'smart');
      break;
    }
    default:
      logger.warn(`[Poller] Unhandled event: ${event}`);
  }
}

module.exports = { handleWebhook, handleWebhookPayload };