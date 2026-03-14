const { getLedgers } = require('../services/tallyService');
const { callBitrix } = require('../connectors/bitrixConnector');
const logger = require('../utils/logger');

// ─────────────────────────────────────────
// Tally → Bitrix24 Bi-directional Sync
// Fetches all Sundry Debtor/Creditor ledgers from Tally
// Creates missing contacts/companies in Bitrix24
// ─────────────────────────────────────────

// Search Bitrix24 for existing contact by name
async function findBitrixContact(name) {
  try {
    const data = await callBitrix('crm.contact.list', {
      filter: { '%NAME': name },
      select: ['ID', 'NAME', 'LAST_NAME']
    });
    const results = data.result || [];
    return results.find(c =>
      `${c.NAME || ''} ${c.LAST_NAME || ''}`.trim().toLowerCase() === name.toLowerCase()
    ) || null;
  } catch (e) {
    logger.warn('Contact search failed', { name, message: e.message });
    return null;
  }
}

// Search Bitrix24 for existing company by name
async function findBitrixCompany(name) {
  try {
    const data = await callBitrix('crm.company.list', {
      filter: { '%TITLE': name },
      select: ['ID', 'TITLE']
    });
    const results = data.result || [];
    return results.find(c =>
      (c.TITLE || '').toLowerCase() === name.toLowerCase()
    ) || null;
  } catch (e) {
    logger.warn('Company search failed', { name, message: e.message });
    return null;
  }
}

// Create contact in Bitrix24 from Tally ledger
async function createBitrixContact(ledger) {
  // Create as Company — TITLE field always displays correctly in Bitrix24
  const fields = {
    TITLE:    ledger.ledgerName,
    COMMENTS: 'Auto-created from Tally ledger sync'
  };

  if (ledger.phone) fields.PHONE = [{ VALUE: ledger.phone, VALUE_TYPE: 'WORK' }];
  if (ledger.email) fields.EMAIL = [{ VALUE: ledger.email, VALUE_TYPE: 'WORK' }];

  const data = await callBitrix('crm.company.add', { fields });
  return data.result;
}

// Create company in Bitrix24 from Tally ledger
async function createBitrixCompany(ledger) {
  const fields = {
    TITLE:     ledger.ledgerName,
    COMMENTS:  'Auto-created from Tally ledger sync'
  };

  if (ledger.phone) fields.PHONE = [{ VALUE: ledger.phone, VALUE_TYPE: 'WORK' }];

  const data = await callBitrix('crm.company.add', { fields });
  return data.result;
}

const LEDGER_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours minimum between ledger syncs
let lastLedgerSyncTime = 0;

async function processTallyToContact() {
  try {
    logger.info('Tally → Bitrix24 bi-directional sync started');

    // Rate-limit ledger sync — with 16k ledgers, don't hammer Tally every 4 hours
    const now = Date.now();
    if (now - lastLedgerSyncTime < LEDGER_SYNC_INTERVAL_MS) {
      const nextIn = Math.round((LEDGER_SYNC_INTERVAL_MS - (now - lastLedgerSyncTime)) / 60000);
      logger.info(`Ledger sync skipped — last ran less than 6hrs ago (next in ~${nextIn} min)`);
      return { success: true, created: 0, skipped: 0, failed: 0 };
    }
    lastLedgerSyncTime = now;

    // Step 1: Fetch Sundry Debtor ledgers from Tally in batches
    const ledgers = await getLedgers();

    if (!ledgers || ledgers.length === 0) {
      logger.info('No ledgers found in Tally to sync');
      return { success: true, created: 0, skipped: 0 };
    }

    logger.info(`Found ${ledgers.length} ledgers in Tally to check`);

    let created = 0;
    let skipped = 0;
    let failed  = 0;

    for (const ledger of ledgers) {
      try {
        // Step 2: Check if already exists in Bitrix24
        // Try company first (most Tally ledgers are businesses)
        const existingCompany = await findBitrixCompany(ledger.ledgerName);
        if (existingCompany) {
          // Update existing company with latest details from Tally
          const updateFields = {};
          if (ledger.phone) updateFields.PHONE = [{ VALUE: ledger.phone, VALUE_TYPE: 'WORK' }];
          if (ledger.email) updateFields.EMAIL = [{ VALUE: ledger.email, VALUE_TYPE: 'WORK' }];
          if (ledger.gstin) updateFields.UF_CRM_GSTIN = ledger.gstin;

          if (Object.keys(updateFields).length > 0) {
            await callBitrix('crm.company.update', {
              id:     existingCompany.ID,
              fields: updateFields
            });
            logger.info('Bitrix24 company updated with latest Tally data', {
              ledgerName: ledger.ledgerName,
              companyId:  existingCompany.ID,
              updated:    Object.keys(updateFields)
            });
          } else {
            logger.info('Ledger already exists — no new data to update', {
              ledgerName: ledger.ledgerName
            });
          }
          skipped++;
          continue;
        }

        const existingContact = await findBitrixContact(ledger.ledgerName);
        if (existingContact) {
          logger.info('Ledger already exists as contact in Bitrix24 — skipping', {
            ledgerName: ledger.ledgerName,
            contactId:  existingContact.ID
          });
          skipped++;
          continue;
        }

        // Step 3: Not found — create as company in Bitrix24
        // (Tally ledgers are almost always businesses)
        // Step 3: Not found — decide company vs contact based on GSTIN
        const isCompany = ledger.gstin && ledger.gstin.length === 15
          || ['regular', 'composition', 'sez'].includes((ledger.gstType || '').toLowerCase());

        if (isCompany) {
          const newId = await createBitrixCompany(ledger);
          logger.info('Tally ledger synced to Bitrix24 as COMPANY', {
            ledgerName: ledger.ledgerName,
            gstin: ledger.gstin,
            companyId: newId
          });
        } else {
          const newId = await createBitrixContact(ledger);
          logger.info('Tally ledger synced to Bitrix24 as CONTACT', {
            ledgerName: ledger.ledgerName,
            contactId: newId
          });
        }
        created++;

      } catch (itemError) {
        logger.error('Failed to sync ledger to Bitrix24', {
          ledgerName: ledger.ledgerName,
          message:    itemError.message
        });
        failed++;
      }
    }

    logger.info('Tally → Bitrix24 sync completed', { created, skipped, failed });
    return { success: true, created, skipped, failed };

  } catch (error) {
    if (error.message === 'TALLY_OFFLINE') {
      logger.warn('Ledger sync skipped — Tally is not running');
      return { success: true, created: 0, skipped: 0, failed: 0 };
    }
    logger.error('Tally → Bitrix24 sync failed', { message: error.message });
    throw error;
  }
}

module.exports = { processTallyToContact };