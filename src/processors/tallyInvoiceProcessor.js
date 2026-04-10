const { sendToTally } = require('../connectors/tallyConnector');
const { callBitrix } = require('../connectors/bitrixConnector');
const tallyConfig = require('../config/tallyConfig');
const logger = require('../utils/logger');
const fs   = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '../../logs/tally-invoice-cache.json');

function loadCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {}
  return {};
}

function saveCache(data) {
  try {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    logger.warn('[TallyInvoice] Cache save failed: ' + e.message);
  }
}

// Fetch sales vouchers from Tally Day Book
async function getSalesVouchers() {
  logger.info('Fetching sales vouchers from Tally (monthly chunks)');

  const fmt = (d) => {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${d.getDate()}-${months[d.getMonth()]}-${d.getFullYear()}`;
  };

  // Fetch only current month + previous month to avoid hanging TallyPrime.
  // Increase MONTHS_BACK cautiously — each extra month adds load.
  const startDate = new Date('2025-04-01'); // FY 2025
  const endDate   = new Date('2025-12-01'); 
  const chunks    = [];
  let cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  while (cursor <= endDate) {
    const chunkStart = new Date(cursor);
    const chunkEnd   = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    chunks.push({
      from: fmt(chunkStart),
      to:   fmt(chunkEnd > endDate ? endDate : chunkEnd),
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let allVouchers = [];

  for (const chunk of chunks) {
    try {
      const xml = `
        <ENVELOPE>
          <HEADER>
            <VERSION>1</VERSION>
            <TALLYREQUEST>Export</TALLYREQUEST>
            <TYPE>Collection</TYPE>
            <ID>BX Voucher Collection</ID>
          </HEADER>
          <BODY>
            <DESC>
              <STATICVARIABLES>
                <SVCurrentCompany>${tallyConfig.company}</SVCurrentCompany>
                <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
                <SVFROMDATE>${chunk.from}</SVFROMDATE>
                <SVTODATE>${chunk.to}</SVTODATE>
              </STATICVARIABLES>
              <TDL>
                <TDLMESSAGE>
                  <COLLECTION NAME="BX Voucher Collection" ISMODIFY="No">
                    <TYPE>Voucher</TYPE>
                    <FILTERS>BXDateFilter,BXNotCancelled,BXVoucherTypeFilter</FILTERS>
                    <NATIVEMETHOD>Date</NATIVEMETHOD>
                    <NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
                    <NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD>
                    <NATIVEMETHOD>Amount</NATIVEMETHOD>
                    <NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD>
                    <NATIVEMETHOD>Narration</NATIVEMETHOD>
                  </COLLECTION>
                  <SYSTEM TYPE="Formulae" NAME="BXDateFilter">
                    $$IsInPeriod:$Date:${chunk.from}:${chunk.to}
                  </SYSTEM>
                  <SYSTEM TYPE="Formulae" NAME="BXNotCancelled">
                    NOT $$IsCancelled
                  </SYSTEM>
                  <SYSTEM TYPE="Formulae" NAME="BXVoucherTypeFilter">
                    ($VoucherTypeName = "Tax Invoice Thane") OR
                    ($VoucherTypeName = "Tax Invoice TSS") OR
                    ($VoucherTypeName = "Tally Service Invoice") OR
                    ($VoucherTypeName = "Tax Invoice Mumbai") OR
                    ($VoucherTypeName = "Tax Invoice Cloud") OR
                    ($VoucherTypeName = "Tax Invoice License")
                  </SYSTEM>
                </TDLMESSAGE>
              </TDL>
            </DESC>
          </BODY>
        </ENVELOPE>`.trim();

      logger.info(`[TallyInvoice] Fetching ${chunk.from} → ${chunk.to}`);
      const response = await sendToTally(xml);

      // Diagnostic — log what voucher types exist in this chunk's response
      const totalVoucherTags = (response.match(/<VOUCHER\b/gi) || []).length;
      if (totalVoucherTags > 0) {
        const typeMatches = [...response.matchAll(/VCHTYPE="([^"]+)"/gi)];
        const nameMatches = [...response.matchAll(/<VOUCHERTYPENAME[^>]*>(.*?)<\/VOUCHERTYPENAME>/gi)];
        const uniqueTypes = [...new Set([
          ...typeMatches.map(m => `attr:${m[1].trim()}`),
          ...nameMatches.map(m => `tag:${m[1].trim()}`),
        ])];
        logger.warn(`[TallyInvoice] Chunk ${chunk.from}→${chunk.to} — ${totalVoucherTags} VOUCHER tags found`, { uniqueTypes });

        // Dump first VOUCHER block raw XML so we can see exact tag structure
        const firstVoucherMatch = response.match(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/i);
        if (firstVoucherMatch) {
          logger.warn('[TallyInvoice] First VOUCHER block (first 1200 chars):', firstVoucherMatch[0].substring(0, 1200));
        }
      } else {
        logger.warn(`[TallyInvoice] Chunk ${chunk.from}→${chunk.to} — 0 VOUCHER tags in response (response length: ${response.length})`);
      }

      const vouchers = parseSalesVouchersXml(response);
      allVouchers = allVouchers.concat(vouchers);
      await sleep(1500); // pause between chunks so Tally can breathe
    } catch (e) {
      logger.warn(`[TallyInvoice] Chunk ${chunk.from}→${chunk.to} failed — skipping`, { message: e.message });
    }
  }

  logger.info(`[TallyInvoice] Total vouchers fetched across all chunks: ${allVouchers.length}`);
  return allVouchers;
}

// Parse sales vouchers from Day Book XML
function parseSalesVouchersXml(xml) {
  try {
    const vouchers = [];
    const voucherRegex = /<VOUCHER\b([^>]*)>([\s\S]*?)<\/VOUCHER>/gi;
    let match;

    while ((match = voucherRegex.exec(xml)) !== null) {
      const block = match[2];

      const get = (tag) => {
        const m = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'i').exec(block);
        return m ? m[1].trim() : '';
      };

      // VCHTYPE is on the <VOUCHER> tag attribute, not a child tag
      const vchtypeAttr = (match[1].match(/VCHTYPE="([^"]+)"/i) || [])[1] || '';
      const voucherType = get('VOUCHERTYPENAME') || vchtypeAttr;

      // Skip cancelled vouchers
      const isCancelled = /ACTION="Cancel"/i.test(match[1]);
      if (isCancelled) continue;

      // Skip vouchers with no type info at all
      if (!voucherType.trim()) continue;

      const SALES_EXCLUDE = ['receipt', 'payment', 'journal', 'contra', 'purchase', 'debit note', 'credit note', 'stock journal'];
      const voucherTypeLower = voucherType.toLowerCase();
      const isSales = !SALES_EXCLUDE.some(t => voucherTypeLower.includes(t));
      if (!isSales) {
        logger.info(`[TallyInvoice] Skipped voucher type: "${voucherType}"`);
        continue;
      }
      logger.info(`[TallyInvoice] Accepted voucher type: "${voucherType}" | party: "${get('PARTYLEDGERNAME')}" | amount: ${get('AMOUNT')}`);

      // Skip vouchers created by Bitrix24 (already synced Bitrix→Tally)
      const voucherNumber = get('VOUCHERNUMBER') || '';
      if (voucherNumber.startsWith('BX-')) continue;

      // Tally uses different tags depending on voucher type — try all known locations
      const partyName = get('PARTYLEDGERNAME')
        || get('BASICBUYERNAME')
        || get('BASICBILLLEDGERNAME')
        || (() => {
          // fallback: first non-Sales ledger entry name
          const entryMatch = block.match(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/i);
          if (entryMatch) {
            const ledgerName = entryMatch[1].match(/<LEDGERNAME>(.*?)<\/LEDGERNAME>/i);
            return ledgerName ? ledgerName[1].trim() : '';
          }
          return '';
        })();

      const dateRaw   = get('DATE') || '';
      const narration = get('NARRATION') || '';

      // AMOUNT on the voucher tag may be negative (credit side) — try absolute value
      // Also check BASICAMOUNT and ledger entry amounts as fallback
      const rawAmount = get('AMOUNT') || get('BASICAMOUNT') || get('GRANDTOTAL') || '0';
      const amount    = Math.abs(parseFloat(rawAmount.replace(/,/g, '')) || 0);

      // Debug log so we can see exactly what's being extracted
      logger.info(`[TallyInvoice] Voucher parsed`, {
        voucherType,
        voucherNumber: get('VOUCHERNUMBER') || '',
        partyName,
        amount,
        dateRaw,
      });

      if (!partyName || amount === 0) {
        logger.warn(`[TallyInvoice] Voucher dropped — missing party or amount`, {
          voucherType,
          voucherNumber: get('VOUCHERNUMBER') || '',
          partyName: partyName || '(empty)',
          amount,
        });
        continue;
      }

      const date = dateRaw.length === 8
        ? `${dateRaw.slice(0,4)}-${dateRaw.slice(4,6)}-${dateRaw.slice(6,8)}`
        : dateRaw;

      vouchers.push({ voucherNumber, partyName, date, amount, voucherType, narration });
    }

    logger.info(`Parsed ${vouchers.length} sales vouchers from Tally`);
    return vouchers;
  } catch (err) {
    logger.error('Failed to parse sales vouchers XML', { message: err.message });
    return [];
  }
}

// Find contact or company in Bitrix24 by name
async function findBitrixParty(partyName) {
  try {
    const companyData = await callBitrix('crm.company.list', {
      filter: { '%TITLE': partyName },
      select: ['ID', 'TITLE'],
    });
    const companies = companyData.result || [];
    const company   = companies.find(c =>
      (c.TITLE || '').toLowerCase() === partyName.toLowerCase()
    );
    if (company) return { COMPANY_ID: company.ID };

    const contactData = await callBitrix('crm.contact.list', {
      filter: { '%NAME': partyName },
      select: ['ID', 'NAME', 'LAST_NAME'],
    });
    const contacts = contactData.result || [];
    const contact  = contacts.find(c =>
      `${c.NAME || ''} ${c.LAST_NAME || ''}`.trim().toLowerCase() === partyName.toLowerCase()
    );
    if (contact) return { CONTACT_ID: contact.ID };
  } catch (e) {
    logger.warn('Party lookup failed', { partyName, message: e.message });
  }
  return {};
}

// Check if a Smart Invoice with this Tally voucher number already exists in Bitrix24.
// This is the secondary dedup guard — the local file cache is the primary guard,
// but if the cache is wiped we need this to avoid creating duplicates.
async function invoiceExistsInBitrix(voucherNumber) {
  try {
    const data = await callBitrix('crm.item.list', {
      entityTypeId: 31,
      filter: { UF_TALLY_VOUCHER_NO: voucherNumber },
      select: ['id'],
    });
    return (data.result?.items?.length ?? 0) > 0;
  } catch (e) {
    // Non-fatal — if the check fails we proceed and let the cache guard handle it
    logger.warn('[TallyInvoice] Pre-push dedup check failed — proceeding', {
      voucherNumber,
      message: e.message,
    });
    return false;
  }
}

// Push a Tally sales voucher into Bitrix24 as a Smart Invoice
async function pushVoucherToBitrix(voucher, partyIds) {
  const fields = {
    title:        `${voucher.partyName} - ${voucher.voucherNumber}`,
    opportunity:  voucher.amount,
    currencyId:   'INR',
    createdTime:  voucher.date,
    closeDate:    voucher.date,
    ...partyIds,
    UF_TALLY_VOUCHER_NO: voucher.voucherNumber,
    UF_TALLY_SYNCED:     'Y',
  };

  const data = await callBitrix('crm.item.add', {
    entityTypeId: 31, // Smart Invoice
    fields,
  });

  return data.result?.item?.id || data.result;
}

// Main Tally → Bitrix24 invoice processor
async function processTallyInvoices() {
  try {
    logger.info('Tally → Bitrix24 invoice sync started');

    const vouchers = await getSalesVouchers();

    if (!vouchers || vouchers.length === 0) {
      logger.info('No sales vouchers found in Tally');
      return { success: true, created: 0, skipped: 0 };
    }

    const cache    = loadCache();
    const newCache = { ...cache };
    let created = 0;
    let skipped = 0;
    let failed  = 0;

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    for (const voucher of vouchers) {
      try {
        const cacheKey = `${voucher.voucherNumber}_${voucher.amount}`;

        // Primary guard — skip if already in local cache
        if (cache[cacheKey]) {
          skipped++;
          continue;
        }

        // Secondary guard — check Bitrix24 directly in case cache was wiped.
        // Runs only when the local cache has no record (avoids an extra API
        // call for the common case where everything is already cached).
        const alreadyExists = await invoiceExistsInBitrix(voucher.voucherNumber);
        if (alreadyExists) {
          logger.info('[TallyInvoice] Invoice already in Bitrix24 — updating cache entry', {
            voucherNumber: voucher.voucherNumber,
          });
          newCache[cacheKey] = { bitrixId: null, syncedAt: new Date().toISOString(), source: 'dedup-check' };
          skipped++;
          continue;
        }

        await sleep(300); // space out Bitrix API calls

        // Find party in Bitrix24
        const partyIds = await findBitrixParty(voucher.partyName);

        // Push to Bitrix24
        const bitrixId = await pushVoucherToBitrix(voucher, partyIds);
        newCache[cacheKey] = { bitrixId, syncedAt: new Date().toISOString() };

        logger.info('Tally invoice pushed to Bitrix24', {
          voucherNumber: voucher.voucherNumber,
          partyName:     voucher.partyName,
          amount:        voucher.amount,
          bitrixId,
        });

        created++;
        await sleep(500);

      } catch (voucherErr) {
        logger.error('Failed to push Tally invoice to Bitrix24', {
          voucherNumber: voucher.voucherNumber,
          message:       voucherErr.message,
        });
        failed++;
      }
    }

    saveCache(newCache);
    logger.info('Tally → Bitrix24 invoice sync completed', { created, skipped, failed });
    return { success: true, created, skipped, failed };

  } catch (error) {
    if (error.message === 'TALLY_OFFLINE') {
      logger.warn('Tally invoice sync skipped — Tally is not running');
      return { success: true, created: 0, skipped: 0 };
    }
    logger.error('Tally invoice sync failed', { message: error.message });
    throw error;
  }
}

module.exports = { processTallyInvoices, getSalesVouchers };