const { sendToTallyLarge } = require('../connectors/tallyConnector');
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
async function getSalesVouchers(fromDate = null) {
  const rawCompany = tallyConfig.company || '';
  // TallyPrime Gold requires the FULL company name including the date suffix
  // e.g. "Rajlaxmi Solutions Private Limited - (From 1-Apr-2016)"
  // Do NOT strip it — Tally uses this as the exact internal identifier
  const companyName = rawCompany;

  logger.info(`Fetching sales vouchers from Tally (quarterly chunks) | company: "${companyName}"`);
  if (!companyName || companyName === 'Test Company') {
    logger.warn('[TallyInvoice] Company name is default "Test Company" — skipping sync until real company is configured in Settings');
    return [];
  }

  const fmt = (d) => {
    const dd   = String(d.getDate()).padStart(2, '0');
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  };

  // Default: current financial year only (fast, won't freeze Tally)
  // For historical backfill, pass an explicit fromDate
  const now = new Date();
  const fyStart = now.getMonth() >= 3
    ? new Date(now.getFullYear(), 3, 1)      // Apr this year
    : new Date(now.getFullYear() - 1, 3, 1); // Apr last year
  const startDate = fromDate ? new Date(fromDate) : fyStart;
  const endDate   = new Date();
  const chunks    = [];
  let cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  while (cursor <= endDate) {
    const chunkStart = new Date(cursor);
    // Monthly chunks — Sales Register respects date filters better than Day Book
    const chunkEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    chunks.push({
      from: fmt(chunkStart),
      to:   fmt(chunkEnd > endDate ? endDate : chunkEnd),
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let allVouchers = [];
  const seenVoucherKeys = new Set(); // dedup across chunks since Tally ignores date filters

  for (const chunk of chunks) {
    try {
      const xml = `
        <ENVELOPE>
          <HEADER>
            <TALLYREQUEST>Export Data</TALLYREQUEST>
          </HEADER>
          <BODY>
            <EXPORTDATA>
              <REQUESTDESC>
                <REPORTNAME>Sales Register</REPORTNAME>
                <STATICVARIABLES>
                  <SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY>
                  <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
                  <SVFROMDATE>${chunk.from}</SVFROMDATE>
                  <SVTODATE>${chunk.to}</SVTODATE>
                </STATICVARIABLES>
              </REQUESTDESC>
            </EXPORTDATA>
          </BODY>
        </ENVELOPE>`.trim();

      logger.info(`[TallyInvoice] Fetching ${chunk.from} → ${chunk.to}`);
      const response = await sendToTallyLarge(xml);

      // Log raw response when it's suspiciously short (empty envelope)
      if (response.length < 300) {
        logger.warn(`[TallyInvoice] Short response (${response.length} bytes) — raw: ${response}`);
      }

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

      const vouchers = parseSalesVouchersXml(response, chunk.from, chunk.to);

      // Hard JS-side date guard — reject any voucher whose date falls outside this chunk
      // This catches the case where Tally ignores SVFROMDATE/SVTODATE entirely
      const [cfdd, cfmm, cfyyyy] = chunk.from.split('-').map(Number);
      const [ctdd, ctmm, ctyyyy] = chunk.to.split('-').map(Number);
      const chunkStartMs = new Date(cfyyyy, cfmm - 1, cfdd).getTime();
      const chunkEndMs   = new Date(ctyyyy, ctmm - 1, ctdd).getTime();

      const dateFilteredVouchers = vouchers.filter(v => {
        if (!v.date || v.date.length < 10) return true; // can't filter, keep it
        const vMs = new Date(v.date).getTime();
        return vMs >= chunkStartMs && vMs <= chunkEndMs;
      });

      // Dedup: if Tally ignores date filters, every chunk returns same vouchers
      const newVouchers = dateFilteredVouchers.filter(v => {
        const key = `${v.voucherNumber}_${v.amount}`;
        if (seenVoucherKeys.has(key)) return false;
        seenVoucherKeys.add(key);
        return true;
      });
      allVouchers = allVouchers.concat(newVouchers);
      // Log if date-filtered result differs from raw parse (Tally ignoring date filters)
      if (vouchers.length > 0 && dateFilteredVouchers.length === 0) {
        logger.warn(`[TallyInvoice] Chunk ${chunk.from}→${chunk.to} — Tally returned ${vouchers.length} vouchers but 0 match this date range (Tally ignoring SVFROMDATE/SVTODATE)`);
      }
      await sleep(2500); // Day Book is lighter than Sales Register — 2.5s avoids Tally lag
    } catch (e) {
      logger.warn(`[TallyInvoice] Chunk ${chunk.from}→${chunk.to} failed — skipping`, { message: e.message });
    }
  }

  logger.info(`[TallyInvoice] Total vouchers fetched across all chunks: ${allVouchers.length}`);
  return allVouchers;
}

// Parse sales vouchers from Day Book XML
function parseSalesVouchersXml(xml, chunkFrom, chunkTo) {
  // Parse chunk boundaries for date filtering (DD-MM-YYYY → Date objects)
  function parseChunkDate(str) {
    if (!str) return null;
    const [dd, mm, yyyy] = str.split('-');
    return new Date(parseInt(yyyy), parseInt(mm) - 1, parseInt(dd));
  }
  const chunkStart = parseChunkDate(chunkFrom);
  const chunkEnd   = parseChunkDate(chunkTo);
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

      // Skip vouchers whose DATE doesn't fall within the requested chunk range
      // Tally sometimes returns master/template vouchers regardless of date filter
      const voucherDateRaw = get('DATE') || '';

      const voucherTypeLower = voucherType.toLowerCase();
      // Day Book contains all voucher types — exclude everything that is clearly not a sales invoice
      const SALES_EXCLUDE = ['receipt', 'payment', 'journal', 'contra', 'purchase', 'credit note', 'stock journal', 'stock transfer', 'delivery', 'tally service invoice'];
      const SALES_INCLUDE = ['tax invoice', 'sales invoice', 'sales', 'invoice'];
      const isSales = SALES_INCLUDE.some(t => voucherTypeLower.includes(t))
        && !SALES_EXCLUDE.some(t => voucherTypeLower.includes(t));
      if (!isSales) {
        logger.info(`[TallyInvoice] Skipped voucher type: "${voucherType}" | cancelled: ${isCancelled} | date: ${get('DATE')}`);
        continue;
      }
      logger.info(`[TallyInvoice] Accepted voucher type: "${voucherType}" | party: "${get('PARTYLEDGERNAME')}" | amount: ${get('AMOUNT')}`);

      // Skip vouchers created by Bitrix24 (already synced Bitrix→Tally)
      const voucherNumber = get('VOUCHERNUMBER') || '';
      if (voucherNumber.startsWith('BX-')) continue;

      // Skip vouchers outside the requested chunk date range
      // Tally ignores SVFROMDATE/SVTODATE in Day Book for many configurations
      if (voucherDateRaw.length === 8 && chunkStart && chunkEnd) {
        const vy = parseInt(voucherDateRaw.slice(0, 4));
        const vm = parseInt(voucherDateRaw.slice(4, 6)) - 1;
        const vd = parseInt(voucherDateRaw.slice(6, 8));
        const voucherDate = new Date(vy, vm, vd);
        if (voucherDate < chunkStart || voucherDate > chunkEnd) {
          continue; // silently skip — Tally returned out-of-range voucher
        }
      }

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

      // // Enforce chunk date range — skip vouchers Tally returned outside the requested window
      // if (dateRaw.length === 8 && chunkStart && chunkEnd) {
      //   const vy = parseInt(dateRaw.slice(0, 4));
      //   const vm = parseInt(dateRaw.slice(4, 6)) - 1;
      //   const vd = parseInt(dateRaw.slice(6, 8));
      //   const voucherDate = new Date(vy, vm, vd);
      //   if (voucherDate < chunkStart || voucherDate > chunkEnd) {
      //     logger.info(`[TallyInvoice] Skipping out-of-range voucher | date: ${dateRaw} | chunk: ${chunkFrom}→${chunkTo}`);
      //     continue;
      //   }
      // }

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

      // Parse inventory line items from this voucher
      const items = [];
      const itemRegex = /<ALLINVENTORYENTRIES\.LIST>([\s\S]*?)<\/ALLINVENTORYENTRIES\.LIST>/gi;
      let itemMatch;
      while ((itemMatch = itemRegex.exec(block)) !== null) {
        const itemBlock = itemMatch[1];
        const getI = (tag) => {
          const m = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'i').exec(itemBlock);
          return m ? m[1].trim() : '';
        };
        const stockItemName = getI('STOCKITEMNAME') || '';
        if (!stockItemName) continue;
        const qtyRaw  = getI('ACTUALQTY') || '0';
        const qtyNum  = Math.abs(parseFloat(qtyRaw) || 0);
        const rateRaw = getI('RATE') || '0';
        const rate    = Math.abs(parseFloat(rateRaw.split('/')[0].replace(/,/g, '').trim()) || 0);
        const itemAmt = Math.abs(parseFloat(getI('AMOUNT')) || 0);
        if (qtyNum > 0) {
          items.push({ stockItemName, qty: qtyNum, rate, amount: itemAmt });
        }
      }

      vouchers.push({ voucherNumber, partyName, date, amount, voucherType, narration, items });
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
async function invoiceExistsInBitrix(voucherNumber, partyName = '') {
  // Check 1: by UF_ custom field (fast, may 400 if field not created)
  try {
    const res = await callBitrix('crm.item.list', {
      entityTypeId: 31,
      filter: { '=UF_TALLY_VOUCHER_NO': voucherNumber },
      select: ['id'],
    });
    if ((res.result?.items?.length ?? 0) > 0) return true;
  } catch (_) {
    // UF_ field not available — fall through to title check
  }

  // Check 2: by exact title (always available, no custom field needed)
  if (partyName) {
    try {
      const res = await callBitrix('crm.item.list', {
        entityTypeId: 31,
        filter: { '=title': `${partyName} - ${voucherNumber}` },
        select: ['id'],
      });
      if ((res.result?.items?.length ?? 0) > 0) return true;
    } catch (e) {
      logger.warn('[TallyInvoice] Title dedup check failed — blocking push to be safe', {
        voucherNumber,
        message: e.message,
      });
      // Both checks failed — return true to BLOCK the push
      // safer to skip one invoice than to create 100 duplicates
      return true;
    }
  }

  return false;
}

// Push a Tally sales voucher into Bitrix24 as a Smart Invoice
async function pushVoucherToBitrix(voucher, partyIds, dealId = null, productRows = []) {
  const fields = {
    title:        `${voucher.partyName} - ${voucher.voucherNumber}`,
    opportunity:  voucher.amount,
    currencyId:   'INR',
    createdTime:  voucher.date,
    closeDate:    voucher.date,
    ...partyIds,
    UF_TALLY_VOUCHER_NO: voucher.voucherNumber,
    UF_TALLY_SYNCED:     'Y',
    ...(dealId ? { parentId2: dealId } : {}),
  };

  const data = await callBitrix('crm.item.add', {
    entityTypeId: 31,
    fields,
  });

  const invoiceId = data.result?.item?.id || data.result;

  // Attach product rows if available
  if (invoiceId && productRows.length > 0) {
    try {
      await callBitrix('crm.item.productrow.set', {
        ownerType:   'SI',
        ownerId:     Number(invoiceId),
        productRows,
      });
      logger.info('[TallyInvoice] Product rows attached to invoice', {
        invoiceId,
        rows: productRows.length,
      });
    } catch (rowErr) {
      logger.warn('[TallyInvoice] Product row attach failed — non-fatal', {
        invoiceId,
        message: rowErr.message,
      });
    }
  }

  return invoiceId;
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
        const cacheKey = `${voucher.partyName}_${voucher.voucherNumber}_${voucher.amount}`;

        // Primary guard — skip if already in local cache
        if (cache[cacheKey]) {
          skipped++;
          continue;
        }

        // Secondary guard — check Bitrix24 directly in case cache was wiped.
        // Runs only when the local cache has no record (avoids an extra API
        // call for the common case where everything is already cached).
        const alreadyExists = await invoiceExistsInBitrix(voucher.voucherNumber, voucher.partyName);
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

        // Skip push if party lookup returned nothing — avoids creating orphaned invoices
        // during 503 bursts where the lookup silently fails and returns {}
        if (!partyIds.COMPANY_ID && !partyIds.CONTACT_ID) {
          logger.warn('[TallyInvoice] Party not found in Bitrix24 — skipping push to avoid orphan invoice', {
            voucherNumber: voucher.voucherNumber,
            partyName: voucher.partyName,
          });
          failed++;
          continue;
        }

        // Find matching deal in Bitrix24 pipeline for this voucher
        let dealId = null;
        try {
          const { getTallyPipelineCategoryId } = require('../services/pipelineService');
          const categoryId = await getTallyPipelineCategoryId();
          if (categoryId) {
            const dealSearch = await callBitrix('crm.deal.list', {
              filter: {
                '=TITLE':    `${voucher.partyName} - ${voucher.voucherNumber}`,
                CATEGORY_ID: categoryId,
              },
              select: ['ID', 'TITLE'],
            });
            const deals = (dealSearch.result || []).filter(
              d => (d.TITLE || '').trim().toLowerCase() ===
                   `${voucher.partyName} - ${voucher.voucherNumber}`.trim().toLowerCase()
            );
            if (deals.length > 0) {
              dealId = deals[0].ID;
              logger.info('[TallyInvoice] Matched deal for invoice', {
                voucherNumber: voucher.voucherNumber,
                dealId,
              });
            }
          }
        } catch (dealErr) {
          logger.warn('[TallyInvoice] Deal lookup failed — invoice will be unlinked', {
            voucherNumber: voucher.voucherNumber,
            message: dealErr.message,
          });
        }

        // Build product rows if this voucher has line items
        let productRows = [];
        if (voucher.items && voucher.items.length > 0) {
          try {
            const { fetchAllBitrixProducts } = require('./inventoryProcessor');
            const bitrixProducts = await fetchAllBitrixProducts();
            const productMap = {};
            bitrixProducts.forEach(p => { productMap[(p.NAME || '').toLowerCase()] = p; });

            for (const item of voucher.items) {
              const key = item.stockItemName.toLowerCase();
              const matched = productMap[key];
              productRows.push({
                PRODUCT_NAME: item.stockItemName,
                PRICE:        item.rate > 0 ? item.rate : (matched ? parseFloat(matched.PRICE) || 0 : 0),
                QUANTITY:     item.qty,
                DISCOUNT:     0,
                CURRENCY_ID:  'INR',
                ...(matched ? { PRODUCT_ID: matched.ID } : {}),
              });
            }
            logger.info('[TallyInvoice] Product rows built', {
              voucherNumber: voucher.voucherNumber,
              count: productRows.length,
            });
          } catch (rowErr) {
            logger.warn('[TallyInvoice] Product row build failed — amount-only invoice', {
              voucherNumber: voucher.voucherNumber,
              message: rowErr.message,
            });
          }
        }

        // Push to Bitrix24
        const bitrixId = await pushVoucherToBitrix(voucher, partyIds, dealId, productRows);
        newCache[cacheKey] = { bitrixId, syncedAt: new Date().toISOString() };

        // Deduct inventory in Bitrix24 for each line item
        if (productRows.length > 0) {
          await _deductInventory(productRows, voucher.voucherNumber);
        }

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

// Separated so backfill endpoint can call push logic independently
async function processTallyInvoicesFromVouchers(vouchers) {
  if (!vouchers || vouchers.length === 0) {
    logger.info('No sales vouchers to process');
    return { success: true, created: 0, skipped: 0 };
  }
  const cache    = loadCache();
  const newCache = { ...cache };
  let created = 0, skipped = 0, failed = 0;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (const voucher of vouchers) {
    try {
      const cacheKey = `${voucher.partyName}_${voucher.voucherNumber}_${voucher.amount}`;
      if (cache[cacheKey]) { skipped++; continue; }
      const alreadyExists = await invoiceExistsInBitrix(voucher.voucherNumber, voucher.partyName);
      if (alreadyExists) {
        newCache[cacheKey] = { bitrixId: null, syncedAt: new Date().toISOString(), source: 'dedup-check' };
        skipped++; continue;
      }
      await sleep(300);
      const partyIds = await findBitrixParty(voucher.partyName);
      if (!partyIds.COMPANY_ID && !partyIds.CONTACT_ID) {
        logger.warn('[TallyInvoice] Party not found in Bitrix24 — skipping push to avoid orphan invoice', {
          voucherNumber: voucher.voucherNumber,
          partyName: voucher.partyName,
        });
        failed++;
        continue;
      }
      // Find matching deal
      let dealId = null;
      try {
        const { getTallyPipelineCategoryId } = require('../services/pipelineService');
        const categoryId = await getTallyPipelineCategoryId();
        if (categoryId) {
          const dealSearch = await callBitrix('crm.deal.list', {
            filter: { '=TITLE': `${voucher.partyName} - ${voucher.voucherNumber}`, CATEGORY_ID: categoryId },
            select: ['ID', 'TITLE'],
          });
          const exactDeal = (dealSearch.result || []).find(
            d => (d.TITLE || '').trim().toLowerCase() ===
                 `${voucher.partyName} - ${voucher.voucherNumber}`.trim().toLowerCase()
          );
          if (exactDeal) dealId = exactDeal.ID;
        }
      } catch (_) {}

      // Build product rows
      let productRows = [];
      if (voucher.items && voucher.items.length > 0) {
        try {
          const { fetchAllBitrixProducts } = require('./inventoryProcessor');
          const prods = await fetchAllBitrixProducts();
          const pmap = {};
          prods.forEach(p => { pmap[(p.NAME || '').toLowerCase()] = p; });
          for (const item of voucher.items) {
            const mp = pmap[item.stockItemName.toLowerCase()];
            productRows.push({
              PRODUCT_NAME: item.stockItemName,
              PRICE:        item.rate > 0 ? item.rate : (mp ? parseFloat(mp.PRICE) || 0 : 0),
              QUANTITY:     item.qty,
              DISCOUNT:     0,
              CURRENCY_ID:  'INR',
              ...(mp ? { PRODUCT_ID: mp.ID } : {}),
            });
          }
        } catch (_) {}
      }

      const bitrixId = await pushVoucherToBitrix(voucher, partyIds, dealId, productRows);
      newCache[cacheKey] = { bitrixId, syncedAt: new Date().toISOString() };

      if (productRows.length > 0) {
        await _deductInventory(productRows, voucher.voucherNumber);
      }
      logger.info('Tally invoice pushed to Bitrix24', { voucherNumber: voucher.voucherNumber, partyName: voucher.partyName, amount: voucher.amount, bitrixId });
      created++;
      await sleep(500);
    } catch (e) {
      logger.error('Failed to push Tally invoice', { voucherNumber: voucher.voucherNumber, message: e.message });
      failed++;
    }
  }
  saveCache(newCache);
  logger.info('Tally → Bitrix24 invoice sync completed', { created, skipped, failed });
  return { success: true, created, skipped, failed };
}

// Deduct sold quantities from Bitrix24 product catalog after a Tally invoice is synced.
// This keeps inventory levels accurate — when a bill is created in Tally the stock goes down.
async function _deductInventory(productRows, voucherNumber) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (const row of productRows) {
    if (!row.PRODUCT_ID) continue; // unmapped product — skip
    try {
      // Fetch current quantity from Bitrix24
      const data = await callBitrix('crm.product.get', { id: row.PRODUCT_ID });
      const product = data.result || {};
      const currentQty = parseFloat(product.QUANTITY) || 0;
      const newQty     = Math.max(0, currentQty - (row.QUANTITY || 0));

      await callBitrix('crm.product.update', {
        id:     row.PRODUCT_ID,
        fields: { QUANTITY: newQty },
      });

      logger.info('[TallyInvoice] Inventory deducted', {
        voucherNumber,
        product:    row.PRODUCT_NAME,
        productId:  row.PRODUCT_ID,
        before:     currentQty,
        sold:       row.QUANTITY,
        after:      newQty,
      });
      await sleep(300);
    } catch (e) {
      logger.warn('[TallyInvoice] Inventory deduction failed — non-fatal', {
        voucherNumber,
        product:  row.PRODUCT_NAME,
        message:  e.message,
      });
    }
  }
}

module.exports = { processTallyInvoices, getSalesVouchers, processTallyInvoicesFromVouchers };