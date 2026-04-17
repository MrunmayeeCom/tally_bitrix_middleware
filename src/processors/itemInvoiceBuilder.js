/**
 * itemInvoiceBuilder.js
 * Reads Tally sales vouchers WITH product line items (ALLINVENTORYENTRIES)
 * and creates Bitrix24 Smart Invoices with proper product rows attached.
 *
 * Separate from tallyInvoiceProcessor.js which only syncs the total amount.
 */

const { sendToTally, sendToTallyLarge } = require('../connectors/tallyConnector');
const { callBitrix }           = require('../connectors/bitrixConnector');
const { fetchAllBitrixProducts } = require('./inventoryProcessor');
const tallyConfig              = require('../config/tallyConfig');
const logger                   = require('../utils/logger');
const fs                       = require('fs');
const path                     = require('path');

const CACHE_PATH = path.join(__dirname, '../../logs/invoice-sync-cache.json');

// ── cache helpers ─────────────────────────────────────────────────────────────

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
    logger.warn('[ItemInvoice] Cache save failed: ' + e.message);
  }
}

// ── Tally fetch ───────────────────────────────────────────────────────────────

async function getSalesVouchersWithItems() {
  logger.info('[ItemInvoice] Fetching sales vouchers with line items from Tally (monthly chunks)');

  const fmt = (d) => {
    const dd   = String(d.getDate()).padStart(2, '0');
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  };

  const today     = new Date();
  const startDate = new Date('2025-10-01');
  const chunks    = [];
  let cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  while (cursor <= today) {
    const chunkStart = new Date(cursor);
    const chunkEnd   = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    chunks.push({
      from: fmt(chunkStart),
      to:   fmt(chunkEnd > today ? today : chunkEnd),
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let allVouchers = [];
  const seenVoucherKeys = new Set(); // dedup: Tally often ignores date filters and returns all vouchers in every chunk

  for (const chunk of chunks) {
    try {
      // Convert DD-MM-YYYY → YYYYMMDD for Tally date variables
      const toTallyDate = (dmy) => {
        const [dd, mm, yyyy] = dmy.split('-');
        return `${yyyy}${mm}${dd}`;
      };
      const xml = `
        <ENVELOPE>
          <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
          <BODY>
            <EXPORTDATA>
              <REQUESTDESC>
                <REPORTNAME>Day Book</REPORTNAME>
                <STATICVARIABLES>
                  <SVCURRENTCOMPANY>${tallyConfig.company}</SVCURRENTCOMPANY>
                  <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
                  <SVFROMDATE>${toTallyDate(chunk.from)}</SVFROMDATE>
                  <SVTODATE>${toTallyDate(chunk.to)}</SVTODATE>
                  <EXPLODEFLAG>Yes</EXPLODEFLAG>
                  <SVDISPLAYFORMAT>##DEFAULTFORMAT</SVDISPLAYFORMAT>
                </STATICVARIABLES>
              </REQUESTDESC>
            </EXPORTDATA>
          </BODY>
        </ENVELOPE>`.trim();

      logger.info(`[ItemInvoice] Fetching ${chunk.from} → ${chunk.to}`);
      const response = await sendToTallyLarge(xml);

      // Diagnostic: confirm inventory entry tags are present in raw Tally response
      const invTagCount = (response.match(/<ALLINVENTORYENTRIES\.LIST>/gi) || []).length
        + (response.match(/<INVENTORYENTRIES\.LIST>/gi) || []).length
        + (response.match(/<INVENTORYALLOCATIONS\.LIST>/gi) || []).length;
      logger.info(`[ItemInvoice] Raw XML inventory tag count for chunk ${chunk.from}→${chunk.to}`, {
        ALLINVENTORYENTRIES: (response.match(/<ALLINVENTORYENTRIES\.LIST>/gi) || []).length,
        INVENTORYENTRIES:    (response.match(/<INVENTORYENTRIES\.LIST>/gi) || []).length,
        INVENTORYALLOCATIONS:(response.match(/<INVENTORYALLOCATIONS\.LIST>/gi) || []).length,
        totalInvTags:        invTagCount,
        responseBytes:       response.length,
      });
      const vouchers = parseSalesVouchersWithItems(response);
      const newVouchers = vouchers.filter(v => {
        const key = `${v.voucherNumber}_${v.amount}`;
        if (seenVoucherKeys.has(key)) return false;
        seenVoucherKeys.add(key);
        return true;
      });
      logger.info(`[ItemInvoice] Chunk ${chunk.from}→${chunk.to} — ${vouchers.length} parsed, ${newVouchers.length} new after dedup`);
      allVouchers = allVouchers.concat(newVouchers);
      await sleep(1500);
    } catch (e) {
      logger.warn(`[ItemInvoice] Chunk ${chunk.from}→${chunk.to} failed — skipping`, { message: e.message });
    }
  }

  const withItems = allVouchers.filter(v => v.items && v.items.length > 0);
  if (withItems.length > 0) {
    withItems.forEach(v => {
      logger.info(`[ItemInvoice] Voucher with line items — #${v.voucherNumber} | party: ${v.partyName} | amount: ${v.amount} | items: ${v.items.map(i => `${i.stockItemName} × ${i.qty} @ ${i.rate}`).join(', ')}`);
    });
  } else {
    logger.warn('[ItemInvoice] No vouchers have inventory line items — check Tally voucher type and ALLINVENTORYENTRIES tags');
  }
  logger.info(`[ItemInvoice] Total vouchers fetched across all chunks: ${allVouchers.length} | with line items: ${withItems.length}`);
  return allVouchers;
}

// ── XML parser — captures ALLINVENTORYENTRIES line items ──────────────────────

function parseSalesVouchersWithItems(xml) {
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

    const SALES_EXCLUDE = ['receipt', 'payment', 'journal', 'contra', 'purchase', 'debit note', 'credit note', 'stock'];
    const voucherTypeLower = voucherType.toLowerCase();
    const ITEM_SALES_EXCLUDE = ['receipt', 'payment', 'journal', 'contra', 'purchase', 'debit note', 'credit note', 'stock journal'];
    const isSales = !ITEM_SALES_EXCLUDE.some(t => voucherTypeLower.includes(t));
    if (!isSales) continue;

    // Skip vouchers already created by Bitrix24 sync (BX- prefix)
    const voucherNumber = get('VOUCHERNUMBER') || '';
    if (voucherNumber.startsWith('BX-')) continue;

    const partyName = get('PARTYLEDGERNAME')
      || get('BASICBUYERNAME')
      || get('BASICBILLLEDGERNAME')
      || (() => {
        const entryMatch = block.match(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/i);
        if (entryMatch) {
          const ledgerName = entryMatch[1].match(/<LEDGERNAME>(.*?)<\/LEDGERNAME>/i);
          return ledgerName ? ledgerName[1].trim() : '';
        }
        return '';
      })();

    const dateRaw   = get('DATE') || '';
    const narration = get('NARRATION') || '';
    const rawAmount = get('AMOUNT') || get('BASICAMOUNT') || get('GRANDTOTAL') || '0';
    const amount    = Math.abs(parseFloat(rawAmount.replace(/,/g, '')) || 0);

    if (!partyName || amount === 0) continue;

    // ── Parse inventory line items ────────────────────────────────────────────
    // Tally uses different tags depending on voucher mode:
    // "As Invoice" → ALLINVENTORYENTRIES.LIST
    // "As Voucher" → INVENTORYENTRIES.LIST or INVENTORYALLOCATIONS.LIST
    const items = [];
    const itemRegex = /<(?:ALL)?INVENTORYENTRIES\.LIST>([\s\S]*?)<\/(?:ALL)?INVENTORYENTRIES\.LIST>|<INVENTORYALLOCATIONS\.LIST>([\s\S]*?)<\/INVENTORYALLOCATIONS\.LIST>/gi;
    let itemMatch;

    while ((itemMatch = itemRegex.exec(block)) !== null) {
      const itemBlock = itemMatch[1] || itemMatch[2]; // capture group 1 or 2

      const getI = (tag) => {
        const m = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'i').exec(itemBlock);
        return m ? m[1].trim() : '';
      };

      const stockItemName = getI('STOCKITEMNAME') || '';
      if (!stockItemName) continue;

      // ACTUALQTY comes as "5 Nos" or "5.00 Nos" — extract number and unit separately
      const qtyRaw  = getI('ACTUALQTY') || '0';
      const qtyNum  = Math.abs(parseFloat(qtyRaw) || 0);
      const qtyUnit = (qtyRaw.match(/[a-zA-Z]+/) || [''])[0].trim();

      // RATE comes as "10.00/Nos" or "10.00/ Nos" — extract number before the slash
      const rateRaw  = getI('RATE') || '0';
      const ratePart = rateRaw.split('/')[0].replace(/,/g, '').trim();
      const rate     = Math.abs(parseFloat(ratePart) || 0);

      const itemAmount = Math.abs(parseFloat(getI('AMOUNT')) || 0);

      if (qtyNum > 0) {
        items.push({
          stockItemName,
          qty:    qtyNum,
          rate,
          amount: itemAmount,
          unit:   qtyUnit,
        });
      }
    }

    // Fallback: scan for STOCKITEMNAME anywhere in the voucher block
    // Some Tally configurations embed inventory under LEDGERENTRIES or other tags
    if (items.length === 0) {
      const stockNameMatches = [...block.matchAll(/<STOCKITEMNAME[^>]*>(.*?)<\/STOCKITEMNAME>/gi)];
      const qtyMatches       = [...block.matchAll(/<ACTUALQTY[^>]*>(.*?)<\/ACTUALQTY>/gi)];
      const rateMatches      = [...block.matchAll(/<RATE[^>]*>(.*?)<\/RATE>/gi)];
      stockNameMatches.forEach((nm, i) => {
        const sName = nm[1].trim();
        if (!sName) return;
        const qtyRaw  = (qtyMatches[i]  || [])[1] || '0';
        const rateRaw = (rateMatches[i] || [])[1] || '0';
        const qtyNum  = Math.abs(parseFloat(qtyRaw) || 0);
        const rate    = Math.abs(parseFloat(rateRaw.split('/')[0].replace(/,/g, '').trim()) || 0);
        if (qtyNum > 0) {
          items.push({ stockItemName: sName, qty: qtyNum, rate, amount: qtyNum * rate, unit: '' });
          logger.info('[ItemInvoice] Stock item found via fallback scan', { stockItemName: sName, qty: qtyNum, rate });
        }
      });
    }

    const date = dateRaw.length === 8
      ? `${dateRaw.slice(0,4)}-${dateRaw.slice(4,6)}-${dateRaw.slice(6,8)}`
      : dateRaw;

    vouchers.push({
      voucherNumber,
      partyName,
      date,
      amount,
      voucherType,
      narration,
      items,
    });
  }

  logger.info(`[ItemInvoice] Parsed ${vouchers.length} sales vouchers — ` +
    `${vouchers.filter(v => v.items.length > 0).length} have line items`);
  return vouchers;
}

// ── Bitrix24 helpers ──────────────────────────────────────────────────────────

// Find existing contact or company in Bitrix24 by party name
async function findBitrixParty(partyName) {
  try {
    const companyData = await callBitrix('crm.company.list', {
      filter: { '%TITLE': partyName },
      select: ['ID', 'TITLE'],
    });
    const company = (companyData.result || []).find(
      c => (c.TITLE || '').toLowerCase() === partyName.toLowerCase()
    );
    if (company) return { companyId: company.ID };

    const contactData = await callBitrix('crm.contact.list', {
      filter: { '%NAME': partyName },
      select: ['ID', 'NAME', 'LAST_NAME'],
    });
    const contact = (contactData.result || []).find(
      c => `${c.NAME || ''} ${c.LAST_NAME || ''}`.trim().toLowerCase() === partyName.toLowerCase()
    );
    if (contact) return { contactId: contact.ID };
  } catch (e) {
    logger.warn('[ItemInvoice] Party lookup failed', { partyName, message: e.message });
  }
  return {};
}

// Build Bitrix24 product rows from Tally line items
// Matches each Tally stock item name against the Bitrix24 product catalog
function buildProductRows(tallyItems, bitrixProducts) {
  // Build a lookup map: lowercase name → Bitrix24 product
  const productMap = {};
  bitrixProducts.forEach(p => {
    productMap[(p.NAME || '').toLowerCase()] = p;
  });

  const rows = [];

  for (const item of tallyItems) {
    const key            = item.stockItemName.toLowerCase();
    const bitrixProduct  = productMap[key];

    // Use Tally rate as the price — most accurate source
    // Fall back to Bitrix24 catalog price if Tally rate is 0
    const price = item.rate > 0
      ? item.rate
      : bitrixProduct ? (parseFloat(bitrixProduct.PRICE) || 0) : 0;

    if (!bitrixProduct) {
      logger.warn('[ItemInvoice] Line item not found in Bitrix24 catalog — skipping item (PRODUCT_ID required)', {
        name: item.stockItemName,
        qty:  item.qty,
        rate: item.rate,
      });
      continue;
    }

    const row = {
      PRODUCT_ID:   Number(bitrixProduct.ID),
      PRICE:        Number(price),
      QUANTITY:     Number(item.qty),
    };

    logger.info('[ItemInvoice] Matched line item to Bitrix24 product', {
      name:      item.stockItemName,
      productId: bitrixProduct.ID,
      price,
    });

    rows.push(row);
  }

  return rows;
}

// ── Main processor ────────────────────────────────────────────────────────────

async function processItemInvoices() {
  try {
    logger.info('[ItemInvoice] Starting item-based invoice sync');

    // Feature gate check
    const featureGate = (() => {
      try { return require('../services/featureGate'); } catch { return null; }
    })();
    if (featureGate && !featureGate.isEnabled('invoice-sync')) {
      logger.info('[ItemInvoice] invoice-sync not enabled on plan — skipping');
      return { success: true, created: 0, skipped: 0 };
    }

    // Fetch Tally vouchers with line items + Bitrix24 product catalog in parallel
    const [vouchers, bitrixProducts] = await Promise.all([
      getSalesVouchersWithItems(),
      fetchAllBitrixProducts(),
    ]);

    logger.info(`[ItemInvoice] ${vouchers.length} vouchers from Tally | ` +
      `${bitrixProducts.length} products in Bitrix24 catalog`);

    if (bitrixProducts.length === 0) {
      logger.warn('[ItemInvoice] No products in Bitrix24 catalog — run inventory sync first to enable item-based invoice sync', {});
    }

    let cache    = loadCache();
    const newCache = {};
    for (const [key, val] of Object.entries(cache)) {
      const normalizedKey = key.replace(/_(\d+\.\d+)$/, (_, amt) => `_${Math.round(parseFloat(amt))}`);
      newCache[normalizedKey] = val;
    }
    if (Object.keys(newCache).length !== Object.keys(cache).length) {
      logger.info('[ItemInvoice] Cache keys normalized (float → integer amounts)');
      saveCache(newCache);
    }
    let created = 0, skipped = 0, failed = 0, noItems = 0;

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    for (const voucher of vouchers) {
      // Normalize amount to integer string to avoid float mismatch (1756 vs 1756.0 vs 1756.00)
      const normalizedAmount = Math.round(voucher.amount);
      const cacheKey = `${voucher.partyName}_${voucher.voucherNumber}_${normalizedAmount}`;
      try {
        // Reload cache from disk periodically to pick up entries written this run
        cache = loadCache();
        // Skip if already synced or previously failed with non-retryable error
        if (cache[cacheKey]) {
          const entry = cache[cacheKey];
          if (entry.failed) {
            // Before waiting for tombstone to expire, check if invoice already exists
            // This clears stuck tombstones caused by productrow.set failures
            try {
              const existCheck = await callBitrix('crm.item.list', {
                entityTypeId: 31,
                filter: { '=title': `${voucher.partyName} - ${voucher.voucherNumber}` },
                select: ['id'],
              });
              if ((existCheck.result?.items?.length ?? 0) > 0) {
                const existingId = existCheck.result.items[0].id;
                logger.info('[ItemInvoice] Tombstoned voucher already exists in Bitrix24 — clearing tombstone', {
                  voucherNumber: voucher.voucherNumber,
                  invoiceId: existingId,
                });
                newCache[cacheKey] = {
                  invoiceId:     existingId,
                  syncedAt:      new Date().toISOString(),
                  source:        'tombstone-cleared',
                  partyName:     voucher.partyName,
                  voucherNumber: voucher.voucherNumber,
                };
                skipped++;
                continue;
              }
            } catch (_) {}

            const ageMs = Date.now() - (entry.failedAt || 0);
            if (ageMs < 60 * 60 * 1000) {
              logger.info('[ItemInvoice] Skipping tombstoned voucher (< 1hr old)', {
                voucherNumber: voucher.voucherNumber,
                ageMinutes: Math.floor(ageMs / 60000),
              });
              skipped++;
              continue;
            }
            logger.info('[ItemInvoice] Tombstone expired — retrying voucher', {
              voucherNumber: voucher.voucherNumber,
            });
            delete newCache[cacheKey];
          } else {
            skipped++;
            continue;
          }
        }

        // Vouchers without inventory line items are synced as amount-only invoices.
        // The title and amount are still valuable in Bitrix24 even without product rows.
        const hasItems = voucher.items && voucher.items.length > 0;
        if (!hasItems) {
          noItems++; // counted but NOT skipped
        }

        // Check if this invoice already exists in Bitrix24 before creating
        // Handles tombstone-retry case where invoice was created but productrow.set failed
        try {
          const existCheck = await callBitrix('crm.item.list', {
            entityTypeId: 31,
            filter: { '=title': `${voucher.partyName} - ${voucher.voucherNumber}` },
            select: ['id'],
          });
          if ((existCheck.result?.items?.length ?? 0) > 0) {
            const existingId = existCheck.result.items[0].id;
            logger.info('[ItemInvoice] Invoice already exists in Bitrix24 — marking as synced', {
              voucherNumber: voucher.voucherNumber,
              invoiceId: existingId,
            });
            newCache[cacheKey] = {
              invoiceId:     existingId,
              syncedAt:      new Date().toISOString(),
              source:        'dedup-check',
              partyName:     voucher.partyName,
              voucherNumber: voucher.voucherNumber,
            };
            saveCache(newCache); // write immediately so next run skips via cache, not Bitrix API
            skipped++;
            continue;
          }
        } catch (_) {
          // Check failed — proceed with create, dedup cache will prevent future duplicates
        }

        // Find the party in Bitrix24
        const partyIds = await findBitrixParty(voucher.partyName);
        await sleep(300); // avoid rate limiting

        // Build product rows from Tally line items
        const productRows = buildProductRows(voucher.items, bitrixProducts);

        // Step 0 — Find or create Deal first (Smart Invoice products work better when linked to deals)
        let dealId = null;
        try {
          const { getTallyPipelineCategoryId } = require('../services/pipelineService');
          const categoryId = await getTallyPipelineCategoryId();
          if (categoryId) {
            // Search for existing deal even if no company/contact exists - use party name directly
            const dealSearch = await callBitrix('crm.deal.list', {
              filter: {
                '%TITLE': voucher.partyName,
                CATEGORY_ID: categoryId,
                '=OPPORTUNITY': voucher.amount,
              },
              select: ['ID', 'TITLE', 'OPPORTUNITY'],
            });
            const deals = dealSearch.result || [];
            if (deals.length > 0) {
              dealId = deals[0].ID;
              logger.info('[ItemInvoice] Matched existing deal by party+amount', {
                voucherNumber: voucher.voucherNumber,
                dealId,
                amount: voucher.amount,
              });
            } else {
              logger.info('[ItemInvoice] No matching deal — will create new deal', {
                voucherNumber: voucher.voucherNumber,
                partyName: voucher.partyName,
                amount: voucher.amount,
              });
            }
          }
        } catch (dealErr) {
          logger.warn('[ItemInvoice] Deal lookup failed', { message: dealErr.message });
        }

        // Step 1 — Create new deal if no matching deal found (even without company/contact)
        if (!dealId) {
          try {
            const { getTallyPipelineCategoryId } = require('../services/pipelineService');
            const categoryId = await getTallyPipelineCategoryId();
            if (categoryId) {
              const newDeal = await callBitrix('crm.deal.add', {
                fields: {
                  TITLE: `${voucher.partyName} - ${voucher.voucherNumber}`,
                  OPPORTUNITY: voucher.amount,
                  CURRENCY_ID: 'INR',
                  COMPANY_ID: partyIds.companyId,
                  CONTACT_ID: partyIds.contactId,
                  CATEGORY_ID: categoryId,
                  CLOSEDATE: voucher.date,
                },
              });
              dealId = newDeal.result;
              logger.info('[ItemInvoice] Created new deal for invoice', {
                voucherNumber: voucher.voucherNumber,
                dealId,
                amount: voucher.amount,
              });
            }
          } catch (createErr) {
            logger.warn('[ItemInvoice] Deal creation failed — invoice will be unlinked', {
              message: createErr.message,
            });
          }
        }

        // Step 2 — Create the Smart Invoice in Bitrix24
        // Only fields confirmed valid for crm.item.add (entityTypeId 31)
        // accountNumber and begindate cause 400 on some Bitrix24 versions
        const invoiceFields = {
          title:       `${voucher.partyName} - ${voucher.voucherNumber}`,
          opportunity: voucher.amount,
          currencyId:  'INR',
          closeDate:   voucher.date,
          parentId3:    dealId, // Link to deal
          ...partyIds,
        };

        const invoiceData = await callBitrix('crm.item.add', {
          entityTypeId: 31, // Smart Invoice
          fields:       invoiceFields,
        });

        const invoiceId = invoiceData.result?.item?.id
          || invoiceData.result?.id
          || (typeof invoiceData.result === 'number' ? invoiceData.result : null);

        if (!invoiceId) {
          logger.error('[ItemInvoice] Invoice creation returned no ID', {
            voucherNumber: voucher.voucherNumber,
            rawResult: JSON.stringify(invoiceData.result).substring(0, 200),
          });
          failed++;
          continue;
        }

        // Step 3 — Attach product rows to the deal first (invoice may inherit)
        if (productRows.length > 0 && dealId) {
          logger.info('ATTACHING PRODUCT ROWS TO DEAL', { dealId, productRows });
          await sleep(500); // give Bitrix24 time to finalize newly created deal
          try {
            await callBitrix('crm.deal.productrows.set', {
              id: Number(dealId),
              productRows,
            });
            logger.info('[ItemInvoice] Product rows attached to deal', {
              dealId,
              count: productRows.length,
            });
          } catch (dealRowErr) {
            logger.warn('[ItemInvoice] Product row attach to deal failed', {
              dealId,
              message: dealRowErr.message,
            });
          }
        }

        // Step 4 — Attach product rows to the invoice
        logger.info('[ItemInvoice] Product rows to attach', {
          invoiceId,
          count: productRows.length,
          rows: productRows.map(r => `${r.PRODUCT_NAME} × ${r.QUANTITY} @ ${r.PRICE}`).join(', '),
        });

        if (productRows.length === 0 && voucher.items && voucher.items.length > 0) {
          logger.warn('[ItemInvoice] No product rows built — items exist in Tally but none matched Bitrix24 catalog. Run inventory sync first.', {
            invoiceId,
            tallyItems: voucher.items.map(i => i.stockItemName).join(', '),
          });
        }
        if (productRows.length > 0) {
          logger.info('ATTACHING PRODUCT ROWS TO INVOICE', { invoiceId, productRows });
          try {
            let rowSetResult;
            try {
              rowSetResult = await callBitrix('crm.item.productrow.set', {
                ownerType: 31,
                ownerId:   Number(invoiceId),
                productRows,
              });
            } catch (e1) {
              logger.warn('[ItemInvoice] productrow.set with ownerType SI failed — retrying with ownerTypeId 31', { message: e1.message });
              rowSetResult = await callBitrix('crm.item.productrow.set', {
                ownerTypeId: 31,
                ownerId:     Number(invoiceId),
                productRows,
              });
            }
          // Verify rows actually saved — Bitrix24 sometimes returns 200 but saves nothing
          try {
            const verify = await callBitrix('crm.item.productrow.list', {
              ownerType: 31,
              ownerId:   Number(invoiceId),
            });
            const savedRows = verify.result?.productRows || [];
            if (savedRows.length === 0) {
              logger.warn('[ItemInvoice] productrow.set returned 200 but rows are empty — Bitrix24 silently dropped them', {
                invoiceId,
                attempted: productRows.length,
              });
            } else {
              logger.info('[ItemInvoice] Product rows confirmed saved', {
                invoiceId,
                rows:     savedRows.length,
                products: productRows.map(r => `${r.PRODUCT_NAME} × ${r.QUANTITY}`).join(', '),
              });
            }
          } catch (verifyErr) {
            // Non-fatal — log and move on
            logger.info('[ItemInvoice] Product rows attached (verify check skipped)', {
              invoiceId,
              rows:     productRows.length,
              products: productRows.map(r => `${r.PRODUCT_NAME} × ${r.QUANTITY}`).join(', '),
            });
          }
          } catch (rowErr) {
            // productrow.set failed — non-fatal, invoice already created successfully
            logger.warn('[ItemInvoice] Product row attach failed — invoice created but rows missing', {
              invoiceId,
              voucherNumber: voucher.voucherNumber,
              message: rowErr.message,
            });
          }
        }

        // Try to write tracking fields separately — non-fatal if UF_ fields don't exist
        try {
          await callBitrix('crm.item.update', {
            entityTypeId: 31,
            id:           invoiceId,
            fields: {
              UF_TALLY_VOUCHER_NO: voucher.voucherNumber,
              UF_INVOICE_NUMBER:   voucher.voucherNumber,
              UF_INVOICE_DATE:     voucher.date,
            },
          });
        } catch (ufErr) {
          logger.info('[ItemInvoice] UF_ field update skipped — fields may not exist on this instance', {
            invoiceId, message: ufErr.message,
          });
        }

        // Save to cache so we don't recreate on next run
        newCache[cacheKey] = {
          invoiceId,
          syncedAt:   new Date().toISOString(),
          itemCount:  productRows.length,
          partyName:  voucher.partyName,
          voucherNumber: voucher.voucherNumber,
        };
        saveCache(newCache); 

        logger.info('[ItemInvoice] Item-based invoice created successfully', {
          voucherNumber: voucher.voucherNumber,
          partyName:     voucher.partyName,
          amount:        voucher.amount,
          lineItems:     productRows.length,
          invoiceId,
        });

        created++;
        await sleep(500); // rate limiting between invoices

      } catch (e) {
        logger.error('[ItemInvoice] Failed to create item invoice', {
          voucherNumber: voucher.voucherNumber,
          partyName:     voucher.partyName,
          message:       e.message,
        });
        // Tombstone 400 errors for 1 hour — prevents hammering but allows retry after fix
        if (e.message && e.message.includes('400')) {
          newCache[cacheKey] = {
            failed:    true,
            reason:    e.message,
            failedAt:  Date.now(),
          };
        }
        failed++;
      }
    }

    // Save cache whenever anything changed — created, tombstoned, or dedup-backfilled
    saveCache(newCache);

    logger.info('[ItemInvoice] Sync complete', { created, skipped, noItems, failed });
    return { success: true, created, skipped, noItems, failed };

  } catch (error) {
    if (error.message === 'TALLY_OFFLINE') {
      logger.warn('[ItemInvoice] Skipped — Tally is not running');
      return { success: true, created: 0, skipped: 0, noItems: 0 };
    }
    logger.error('[ItemInvoice] Sync failed', { message: error.message });
    throw error;
  }
}

module.exports = { processItemInvoices, getSalesVouchersWithItems, buildProductRows };