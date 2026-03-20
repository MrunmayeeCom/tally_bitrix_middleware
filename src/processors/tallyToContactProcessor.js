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
    // Small delay before each search to avoid 502 rate limiting
    await new Promise(r => setTimeout(r, 300));
    const data = await callBitrix('crm.contact.list', {
      filter: { '%NAME': name },
      select: ['ID', 'NAME', 'LAST_NAME', 'PHONE', 'EMAIL']
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
    // Small delay before each search to avoid 502 rate limiting
    await new Promise(r => setTimeout(r, 300));
    const data = await callBitrix('crm.company.list', {
      filter: { '%TITLE': name },
      select: ['ID', 'TITLE', 'PHONE', 'EMAIL']
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
  const nameParts = ledger.ledgerName.trim().split(/\s+/);
  const fields = {
    NAME:               nameParts[0],
    LAST_NAME:          nameParts.slice(1).join(' ') || '',
    SOURCE_ID:          'OTHER',
    SOURCE_DESCRIPTION: 'TALLY_SYNC',
    COMMENTS:           'Auto-created from Tally ledger sync'
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
    COMMENTS:  'Auto-created from Tally ledger sync',
    SOURCE_ID: 'OTHER',
    SOURCE_DESCRIPTION: 'TALLY_SYNC' // marker to identify auto-created records
  };

  if (ledger.phone) fields.PHONE = [{ VALUE: ledger.phone, VALUE_TYPE: 'WORK' }];

  const data = await callBitrix('crm.company.add', { fields });
  return data.result;
}

let lastLedgerSyncTime = 0;

async function processTallyToContact({ manual = false } = {}) {
  try {
    logger.info('Tally → Bitrix24 bi-directional sync started');

    // Track last run time for logging purposes only
    const now = Date.now();
    lastLedgerSyncTime = now;

    // Step 1: Fetch Sundry Debtor ledgers from Tally in batches
    const ledgers = await getLedgers();

    if (!ledgers || ledgers.length === 0) {
      logger.info('No ledgers found in Tally to sync');
      return { success: true, created: 0, skipped: 0 };
    }

    logger.info(`Found ${ledgers.length} ledgers in Tally to check`);

    // Use change detection — only process ledgers that are new or changed
    // This makes the sync fast enough to run every 5 minutes safely
    const { detectChanges } = require('../watchers/tallyChangeDetector');
    const { added, changed } = detectChanges(ledgers);
    const toProcess = [...added, ...changed];

    if (toProcess.length === 0) {
      logger.info('No changes detected in Tally ledgers — skipping Bitrix24 update');
      return { success: true, created: 0, skipped: ledgers.length, failed: 0 };
    }

    logger.info(`Processing ${toProcess.length} changed/new ledgers out of ${ledgers.length} total`);

    let created = 0;
    let skipped = 0;
    let failed  = 0;

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    for (const ledger of toProcess) {
      try {
        // Step 2: Check if already exists in Bitrix24
        // Try company first (most Tally ledgers are businesses)
        const existingCompany = await findBitrixCompany(ledger.ledgerName);
        if (existingCompany) {
          // Only update existing records if bidirectional-sync is enabled
          const fg = (() => { try { return require('../services/featureGate'); } catch { return null; } })();
          const biDirectional = !fg || fg.isEnabled('bidirectional-sync');
          if (!biDirectional) {
            logger.info('bidirectional-sync not enabled — skipping update for existing company', { ledgerName: ledger.ledgerName });
            skipped++;
            continue;
          }
          const updateFields = {};
          if (ledger.phone) updateFields.PHONE = [{ VALUE: ledger.phone, VALUE_TYPE: 'WORK' }];
          if (ledger.email) updateFields.EMAIL = [{ VALUE: ledger.email, VALUE_TYPE: 'WORK' }];
          if (ledger.gstin) updateFields.UF_CRM_GSTIN = ledger.gstin;
          // Sync ledger name back — if renamed in Tally, update Bitrix24 company title
          if (ledger.ledgerName && ledger.ledgerName !== existingCompany.TITLE) {
            updateFields.TITLE = ledger.ledgerName;
            logger.info('Ledger name changed in Tally — updating Bitrix24 company title', {
              old: existingCompany.TITLE,
              new: ledger.ledgerName
            });
          }

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
          const fg = (() => { try { return require('../services/featureGate'); } catch { return null; } })();
          const biDirectional = !fg || fg.isEnabled('bidirectional-sync');
          if (!biDirectional) {
            logger.info('bidirectional-sync not enabled — skipping update for existing contact', { ledgerName: ledger.ledgerName });
            skipped++;
            continue;
          }
          const updateFields = {};
          if (ledger.phone) updateFields.PHONE = [{ VALUE: ledger.phone, VALUE_TYPE: 'WORK' }];
          if (ledger.email) updateFields.EMAIL = [{ VALUE: ledger.email, VALUE_TYPE: 'WORK' }];
          // Sync ledger name back — if renamed in Tally, update Bitrix24 contact name
          if (ledger.ledgerName) {
            const nameParts = ledger.ledgerName.trim().split(/\s+/);
            const currentFullName = `${existingContact.NAME || ''} ${existingContact.LAST_NAME || ''}`.trim();
            if (ledger.ledgerName !== currentFullName) {
              updateFields.NAME      = nameParts[0];
              updateFields.LAST_NAME = nameParts.slice(1).join(' ') || '';
              logger.info('Ledger name changed in Tally — updating Bitrix24 contact name', {
                old: currentFullName,
                new: ledger.ledgerName
              });
            }
          }

          if (Object.keys(updateFields).length > 0) {
            await callBitrix('crm.contact.update', {
              id:     existingContact.ID,
              fields: updateFields
            });
            logger.info('Bitrix24 contact updated with latest Tally data', {
              ledgerName: ledger.ledgerName,
              contactId:  existingContact.ID,
              updated:    Object.keys(updateFields)
            });
          } else {
            logger.info('Contact already exists — no new data to update', {
              ledgerName: ledger.ledgerName
            });
          }
          skipped++;
          continue;
        }

        // Step 3: Not found — decide company vs contact using Tally GST type
        // Registered GST entity → Company. Unregistered / no GSTIN → Contact.
        const gstin   = (ledger.gstin   || '').trim();
        const gstType = (ledger.gstType || '').toLowerCase().trim();

        const registeredTypes = ['regular', 'composition', 'sez', 'sez developer',
                                 'deemed export', 'uin holders', 'overseas'];
        // If no GST data available — default to Company
        // Most Rajlaxmi parties are businesses, so Company is the safer default
        const isRegisteredBusiness = !gstin && !gstType ? true : gstin.length === 15 || registeredTypes.includes(gstType);

        if (isRegisteredBusiness) {
          const newId = await createBitrixCompany(ledger);
          logger.info('Tally ledger synced to Bitrix24 as COMPANY — registered GST entity', {
            ledgerName: ledger.ledgerName,
            gstin, gstType, companyId: newId
          });
        } else {
          const newId = await createBitrixContact(ledger);
          logger.info('Tally ledger synced to Bitrix24 as CONTACT — unregistered party', {
            ledgerName: ledger.ledgerName,
            gstType: gstType || 'blank', contactId: newId
          });
        }
        created++;

      } catch (itemError) {
        const is502 = itemError.message?.includes('502') || itemError.message?.includes('503');
        if (is502) {
          logger.warn('Bitrix24 overloaded (502/503) — pausing ledger sync for 10s', {
            ledgerName: ledger.ledgerName
          });
          await sleep(10000); // longer pause when Bitrix24 is struggling
        } else {
          logger.error('Failed to sync ledger to Bitrix24', {
            ledgerName: ledger.ledgerName,
            message:    itemError.message
          });
        }
        failed++;
      }
      await sleep(1500);
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