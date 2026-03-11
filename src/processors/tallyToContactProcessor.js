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
  const nameParts = ledger.ledgerName.trim().split(' ');
  const firstName = nameParts[0] || ledger.ledgerName;
  const lastName  = nameParts.slice(1).join(' ') || '';

  const fields = {
    NAME:      firstName,
    LAST_NAME: lastName,
    SOURCE_ID: 'OTHER',
    COMMENTS:  'Auto-created from Tally ledger sync'
  };

  if (ledger.phone) fields.PHONE = [{ VALUE: ledger.phone, VALUE_TYPE: 'WORK' }];
  if (ledger.email) fields.EMAIL = [{ VALUE: ledger.email, VALUE_TYPE: 'WORK' }];

  const data = await callBitrix('crm.contact.add', { fields });
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

async function processTallyToContact() {
  try {
    logger.info('Tally → Bitrix24 bi-directional sync started');

    // Step 1: Fetch all Sundry Debtor/Creditor ledgers from Tally
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
          logger.info('Ledger already exists as company in Bitrix24 — skipping', {
            ledgerName: ledger.ledgerName,
            companyId:  existingCompany.ID
          });
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
        const newId = await createBitrixCompany(ledger);
        logger.info('Tally ledger synced to Bitrix24 as company', {
          ledgerName: ledger.ledgerName,
          companyId:  newId
        });
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
    logger.error('Tally → Bitrix24 sync failed', { message: error.message });
    throw error;
  }
}

module.exports = { processTallyToContact };