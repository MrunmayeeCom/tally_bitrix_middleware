/**
 * tallyQuotationProcessor.js
 * Reads Tally Sales Order vouchers from Day Book
 * and creates Bitrix24 Estimates (entityTypeId 7) with product rows.
 * Mirrors tallyInvoiceProcessor.js exactly — same dedup, same caching pattern.
 */

const { sendToTallyLarge } = require('../connectors/tallyConnector');
const { callBitrix }       = require('../connectors/bitrixConnector');
const tallyConfig          = require('../config/tallyConfig');
const logger               = require('../utils/logger');
const fs                   = require('fs');
const path                 = require('path');

const CACHE_PATH = path.join(__dirname, '../../logs/quotation-tally-sync-cache.json');

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
    logger.warn('[TallyQuotation] Cache save failed: ' + e.message);
  }
}

// ── Fetch Sales Orders from Tally Day Book ────────────────────────────────────

async function getSalesOrders(fromDate = null) {
  const companyName = tallyConfig.company || '';
  logger.info(`[TallyQuotation] Fetching Sales Orders from Tally | company: "${companyName}"`);

  const fmt = (d) => {
    const dd   = String(d.getDate()).padStart(2, '0');
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  };

  const now = new Date();
  const fyStart = now.getMonth() >= 3
    ? new Date(now.getFullYear(), 3, 1)
    : new Date(now.getFullYear() - 1, 3, 1);
  const startDate = fromDate ? new Date(fromDate) : fyStart;
  const endDate   = new Date();

  const chunks = [];
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
  let allOrders = [];
  const seenKeys = new Set();

  for (const chunk of chunks) {
    try {
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
                  <SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY>
                  <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
                  <SVFROMDATE>${toTallyDate(chunk.from)}</SVFROMDATE>
                  <SVTODATE>${toTallyDate(chunk.to)}</SVTODATE>
                </STATICVARIABLES>
              </REQUESTDESC>
            </EXPORTDATA>
          </BODY>
        </ENVELOPE>`.trim();

      logger.info(`[TallyQuotation] Fetching chunk ${chunk.from} → ${chunk.to}`);
      const response = await sendToTallyLarge(xml);
      const orders   = parseSalesOrdersXml(response, chunk.from, chunk.to);

      const newOrders = orders.filter(o => {
        const key = `${o.voucherNumber}_${o.amount}`;
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });

      allOrders = allOrders.concat(newOrders);
      await sleep(2000);
    } catch (e) {
      logger.warn(`[TallyQuotation] Chunk ${chunk.from}→${chunk.to} failed`, { message: e.message });
    }
  }

  logger.info(`[TallyQuotation] Total Sales Orders fetched: ${allOrders.length}`);
  return allOrders;
}

// ── XML Parser ────────────────────────────────────────────────────────────────

function parseSalesOrdersXml(xml, chunkFrom, chunkTo) {
  function parseChunkDate(str) {
    if (!str) return null;
    const [dd, mm, yyyy] = str.split('-');
    return new Date(parseInt(yyyy), parseInt(mm) - 1, parseInt(dd));
  }
  const chunkStart = parseChunkDate(chunkFrom);
  const chunkEnd   = parseChunkDate(chunkTo);

  try {
    const orders = [];
    const voucherRegex = /<VOUCHER\b([^>]*)>([\s\S]*?)<\/VOUCHER>/gi;
    let match;

    while ((match = voucherRegex.exec(xml)) !== null) {
      const attrs = match[1];
      const block = match[2];

      const get = (tag) => {
        const m = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'i').exec(block);
        return m ? m[1].trim() : '';
      };

      // Only process Sales Order type
      const vchtypeAttr  = (attrs.match(/VCHTYPE="([^"]+)"/i) || [])[1] || '';
      const voucherType  = get('VOUCHERTYPENAME') || vchtypeAttr;
      if (!voucherType.toLowerCase().includes('sales order')) continue;

      // Skip cancelled
      if (/ACTION="Cancel"/i.test(attrs)) continue;

      // Skip BX- prefixed or Bitrix-originated vouchers
      const voucherNumber = get('VOUCHERNUMBER') || '';
      if (voucherNumber.startsWith('BX-')) continue;
      const narration = get('NARRATION') || '';
      if (narration.toLowerCase().includes('bitrix24 quotation') || narration.toLowerCase().includes('bitrix24 estimate')) continue;

      // Also skip if this voucher was synced FROM Bitrix24 — check voucher cache
      try {
        const voucherCachePath = path.join(__dirname, '../../logs/voucher-masterid-cache.json');
        if (fs.existsSync(voucherCachePath)) {
          const voucherCache = JSON.parse(fs.readFileSync(voucherCachePath, 'utf8'));
          const cacheValues = Object.values(voucherCache);
          const isBitrixOrigin = cacheValues.some(entry => {
            const cachedVn = entry.voucherNumber || '';
            return cachedVn === `BX-${voucherNumber}` || cachedVn === `BX-${parseInt(voucherNumber)}`;
          });
          if (isBitrixOrigin) continue;
        }
      } catch (_) {}

      // Date range filter
      const dateRaw = get('DATE') || '';
      if (dateRaw.length === 8 && chunkStart && chunkEnd) {
        const vy = parseInt(dateRaw.slice(0, 4));
        const vm = parseInt(dateRaw.slice(4, 6)) - 1;
        const vd = parseInt(dateRaw.slice(6, 8));
        const vDate = new Date(vy, vm, vd);
        if (vDate < chunkStart || vDate > chunkEnd) continue;
      }

      const partyName = get('PARTYLEDGERNAME')
        || get('BASICBUYERNAME')
        || get('BASICBASEPARTYNAME')
        || '';

      const rawAmount = get('AMOUNT') || '0';
      const amount    = Math.abs(parseFloat(rawAmount.replace(/,/g, '')) || 0);

      if (!partyName || amount === 0) continue;

      const date = dateRaw.length === 8
        ? `${dateRaw.slice(0,4)}-${dateRaw.slice(4,6)}-${dateRaw.slice(6,8)}`
        : dateRaw;

      // Parse due date from BATCHALLOCATIONS ORDERDUEDATE
      let dueDate = '';
      const batchMatch = /<BATCHALLOCATIONS\.LIST>([\s\S]*?)<\/BATCHALLOCATIONS\.LIST>/i.exec(block);
      if (batchMatch) {
        const dueDateRaw = /<ORDERDUEDATE[^>]*>(.*?)<\/ORDERDUEDATE>/i.exec(batchMatch[1]);
        if (dueDateRaw?.[1]) {
          // Convert "5-May-26" → "2026-05-05"
          const months = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
                           Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
          const dm = dueDateRaw[1].match(/(\d+)-([A-Za-z]+)-(\d+)/);
          if (dm) {
            const y = dm[3].length === 2 ? `20${dm[3]}` : dm[3];
            dueDate = `${y}-${months[dm[2]] || '01'}-${dm[1].padStart(2,'0')}`;
          }
        }
      }

      // Parse inventory line items
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
        const rate    = Math.abs(parseFloat(rateRaw.split('/')[0].replace(/,/g,'').trim()) || 0);
        const itemAmt = Math.abs(parseFloat(getI('AMOUNT')) || 0);
        if (qtyNum > 0) items.push({ stockItemName, qty: qtyNum, rate, amount: itemAmt });
      }

      orders.push({ voucherNumber, partyName, date, dueDate, amount, voucherType, items });
    }

    logger.info(`[TallyQuotation] Parsed ${orders.length} Sales Orders`);
    return orders;
  } catch (err) {
    logger.error('[TallyQuotation] Parse failed', { message: err.message });
    return [];
  }
}

// ── Bitrix24 helpers ──────────────────────────────────────────────────────────

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
    logger.warn('[TallyQuotation] Party lookup failed', { partyName, message: e.message });
  }
  return {};
}

async function quotationExistsInBitrix(voucherNumber, partyName) {
  try {
    // Check 1: does the Bitrix→Tally dedup cache have this voucherNumber?
    // If so, this Sales Order was originally created FROM Bitrix24 (BX- prefix stripped by Tally)
    // and we must NOT sync it back — that would create a duplicate estimate in Bitrix24
    try {
      const bitrixDedupPath = path.join(__dirname, '../../logs/quotation-dedup-cache.json');
      if (fs.existsSync(bitrixDedupPath)) {
        const bitrixDedup = JSON.parse(fs.readFileSync(bitrixDedupPath, 'utf8'));
        // Bitrix→Tally stores key as "quotation_{entityId}" — we can't match by voucher number directly
        // But the voucher-masterid-cache stores voucherNumber as "BX-{number}"
        // If this Tally voucherNumber matches any "BX-{voucherNumber}" in the masterid cache, skip it
        const masterCachePath = path.join(__dirname, '../../logs/voucher-masterid-cache.json');
        if (fs.existsSync(masterCachePath)) {
          const masterCache = JSON.parse(fs.readFileSync(masterCachePath, 'utf8'));
          const isBitrixOrigin = Object.values(masterCache).some(entry => {
            const cachedVn = entry.voucherNumber || '';
            return cachedVn === `BX-${voucherNumber}` || cachedVn === `BX-${parseInt(voucherNumber)}`;
          });
          if (isBitrixOrigin) {
            logger.info('[TallyQuotation] Voucher originated from Bitrix24 — skipping reverse sync', { voucherNumber });
            return true; // treat as "already exists" to skip
          }
        }
      }
    } catch (_) {}

    // Check 2: title match in Bitrix24
    if (partyName) {
      const res = await callBitrix('crm.item.list', {
        entityTypeId: 7,
        filter: { '=title': `${partyName} - ${voucherNumber}` },
        select: ['id'],
      });
      if ((res.result?.items?.length ?? 0) > 0) {
        logger.info('[TallyQuotation] Estimate already exists in Bitrix24 by title', {
          voucherNumber, estimateId: res.result.items[0].id,
        });
        return res.result.items[0].id;
      }
    }
    return false;
  } catch (e) {
    logger.warn('[TallyQuotation] Existence check failed — blocking push', { voucherNumber, message: e.message });
    return true;
  }
}

// ── Push a Tally Sales Order into Bitrix24 as an Estimate ────────────────────
async function pushOrderToBitrix(order, partyIds, dealId = null, productRows = []) {
  const expectedTitle = `${order.partyName} - ${order.voucherNumber}`;

  // Final check before creating — catches race with quotationProcessor
  try {
    const finalCheck = await callBitrix('crm.item.list', {
      entityTypeId: 7,
      filter: { '=title': expectedTitle },
      select: ['id', 'title'],
    });
    if ((finalCheck.result?.items?.length ?? 0) > 0) {
      const existingId = finalCheck.result.items[0].id;
      logger.info('[TallyQuotation] Estimate already exists (final check) — skipping', {
        voucherNumber: order.voucherNumber, estimateId: existingId,
      });
      return existingId;
    }
  } catch (_) {}

  const formattedRows = productRows.map(r => ({
    productId:  r.PRODUCT_ID ? Number(r.PRODUCT_ID) : undefined,
    ...(!r.PRODUCT_ID ? { productName: r.PRODUCT_NAME || r.productName || '' } : {}),
    price:      Number(r.PRICE || r.price || 0),
    quantity:   Number(r.QUANTITY || r.quantity || 1),
    discount:   0,
    currencyId: 'INR',
  }));

  const fields = {
    title:       expectedTitle,
    opportunity: order.amount,
    currencyId:  'INR',
    closeDate:   order.dueDate || order.date,
    UF_TALLY_VOUCHER_NO: order.voucherNumber,
    UF_TALLY_SYNCED:     'Y',
    ...partyIds,
    ...(dealId ? { parentId2: Number(dealId) } : {}),
  };

  logger.info('[Product Rows Input - inline with crm.item.add]', formattedRows);

  const data = await callBitrix('crm.item.add', {
    entityTypeId: 7,
    fields,
  });

  const estimateId = data.result?.item?.id
    || data.result?.id
    || (typeof data.result === 'number' ? data.result : null);

  logger.info('[TallyQuotation] Estimate created', {
    estimateId, rowCount: formattedRows.length,
  });

  // Attach product rows separately — Bitrix24 does not persist them inline with crm.item.add for quotes
  if (estimateId && formattedRows.length > 0) {
    try {
      const rowsForApi = formattedRows.map(r => ({
        PRODUCT_ID:   r.productId ? Number(r.productId) : 0,
        PRODUCT_NAME: r.productName || '',
        PRICE:        Number(r.price || 0),
        QUANTITY:     Number(r.quantity || 1),
        DISCOUNT:     0,
        CURRENCY_ID:  r.currencyId || 'INR',
      }));
      await callBitrix('crm.quote.productrows.set', {
        ID:   Number(estimateId),
        rows: rowsForApi,
      });
      logger.info('[TallyQuotation] Product rows attached to estimate', {
        estimateId, rows: rowsForApi.length,
      });
    } catch (rowErr) {
      logger.warn('[TallyQuotation] Product row attach failed — non-fatal', {
        estimateId, message: rowErr.message,
      });
    }
  }

  return estimateId;
}

// ── Main Processor ────────────────────────────────────────────────────────────

async function processTallyQuotations() {
  try {
    logger.info('[TallyQuotation] Starting Tally Sales Order → Bitrix24 Estimate sync');

    const featureGate = (() => { try { return require('../services/featureGate'); } catch { return null; } })();
    if (featureGate && !featureGate.isEnabled('quotation-sync')) {
      logger.info('[TallyQuotation] quotation-sync not enabled on plan — skipping');
      return { success: true, created: 0, skipped: 0 };
    }

    const orders = await getSalesOrders();
    if (!orders || orders.length === 0) {
      logger.info('[TallyQuotation] No Sales Orders found in Tally');
      return { success: true, created: 0, skipped: 0 };
    }

    const cache    = loadCache();
    const newCache = { ...cache };
    let created = 0, skipped = 0, failed = 0;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // Build product map ONCE before processing all orders
    const normalizeProductName = (str) =>
      (str || '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');   // keep hyphens/dots intact — exact name match

    const bitrixProductMap = {};
    try {
      const { fetchAllBitrixProducts } = require('./inventoryProcessor');
      const prods = await fetchAllBitrixProducts();
      prods.forEach(p => {
        const key = normalizeProductName(p.NAME);
        // Prefer product with a valid ID; if tie, prefer one with a price
        if (!bitrixProductMap[key]) {
          bitrixProductMap[key] = p;
        } else {
          const existing = bitrixProductMap[key];
          if (!existing.ID && p.ID) {
            bitrixProductMap[key] = p;
          } else if (existing.ID && p.ID && (!existing.PRICE || existing.PRICE == 0) && p.PRICE > 0) {
            bitrixProductMap[key] = p;
          }
        }
      });
      logger.info('[TallyQuotation] Product map built', { totalProducts: prods.length, uniqueKeys: Object.keys(bitrixProductMap).length });
    } catch (pmapErr) {
      logger.warn('[TallyQuotation] Failed to build product map — product rows will use names only', { message: pmapErr.message });
    }

    for (const order of orders) {
      try {
        const normalizedAmount = Math.round(order.amount);
        const cacheKey = `tally_${order.partyName}_${order.voucherNumber}_${normalizedAmount}`;

        if (cache[cacheKey]) { skipped++; continue; }

        const alreadyExists = await quotationExistsInBitrix(order.voucherNumber, order.partyName);
        if (alreadyExists) {
          newCache[cacheKey] = { bitrixId: null, syncedAt: new Date().toISOString(), source: 'dedup-check' };
          skipped++;
          continue;
        }

        await sleep(300);

        const partyIds = await findBitrixParty(order.partyName);
        if (!partyIds.companyId && !partyIds.contactId) {
          logger.warn('[TallyQuotation] Party not found in Bitrix24 — skipping', {
            voucherNumber: order.voucherNumber, partyName: order.partyName,
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
              filter: { '%TITLE': order.partyName, CATEGORY_ID: categoryId, '=OPPORTUNITY': order.amount },
              select: ['ID', 'TITLE'],
            });
            if ((dealSearch.result || []).length > 0) dealId = dealSearch.result[0].ID;
          }
        } catch (_) {}

        // Build product rows from line items
        let productRows = [];
        if (order.items && order.items.length > 0) {
          try {
            for (const item of order.items) {
              const key = normalizeProductName(item.stockItemName);
              const mp = bitrixProductMap[key];

              if (mp && mp.ID) {
                logger.info('[Product Matched]', {
                  tallyName:  item.stockItemName,
                  bitrixName: mp.NAME,
                  productId:  mp.ID,
                });
                productRows.push({
                  PRODUCT_ID:  Number(mp.ID),
                  PRICE: item.rate > 0
                    ? item.rate
                    : (mp.PRICE && !isNaN(parseFloat(mp.PRICE)) ? parseFloat(mp.PRICE) : 0),
                  QUANTITY:    item.qty,
                  DISCOUNT:    0,
                  CURRENCY_ID: 'INR',
                });
              } else {
                logger.error('[Product Mapping Failed - NOT FOUND IN BITRIX]', {
                  tallyName:     item.stockItemName,
                  normalizedKey: key,
                });
                productRows.push({
                  PRODUCT_NAME: item.stockItemName,
                  PRICE:        item.rate,
                  QUANTITY:     item.qty,
                  DISCOUNT:     0,
                  CURRENCY_ID:  'INR',
                });
              }
            }
          } catch (rowErr) {
            logger.warn('[TallyQuotation] Product row build failed', { message: rowErr.message });
          }
        }

        const estimateId = await pushOrderToBitrix(order, partyIds, dealId, productRows);

        if (!estimateId) {
          logger.error('[TallyQuotation] Estimate creation returned no ID', { voucherNumber: order.voucherNumber });
          failed++;
          continue;
        }

        newCache[cacheKey] = {
          bitrixId:      estimateId,
          syncedAt:      new Date().toISOString(),
          partyName:     order.partyName,
          voucherNumber: order.voucherNumber,
        };
        saveCache(newCache);

        logger.info('[TallyQuotation] Sales Order pushed to Bitrix24 as Estimate', {
          voucherNumber: order.voucherNumber,
          partyName:     order.partyName,
          amount:        order.amount,
          estimateId,
          lineItems:     productRows.length,
        });

        created++;
        await sleep(500);

      } catch (e) {
        logger.error('[TallyQuotation] Failed to push Sales Order', {
          voucherNumber: order.voucherNumber,
          message: e.message,
        });
        failed++;
      }
    }

    saveCache(newCache);
    logger.info('[TallyQuotation] Sync complete', { created, skipped, failed });
    return { success: true, created, skipped, failed };

  } catch (error) {
    if (error.message === 'TALLY_OFFLINE') {
      logger.warn('[TallyQuotation] Skipped — Tally offline');
      return { success: true, created: 0, skipped: 0 };
    }
    logger.error('[TallyQuotation] Sync failed', { message: error.message });
    throw error;
  }
}

// ── Main processor: Tally Sales Orders → Bitrix24 Estimates ─────────────────
async function processTallyQuotationsFromTally() {
  try {
    logger.info('[TallyQuotation] Starting Tally Sales Order → Bitrix24 Estimate sync (from Tally)');

    const featureGate = (() => { try { return require('../services/featureGate'); } catch { return null; } })();
    if (featureGate && !featureGate.isEnabled('quotation-sync')) {
      logger.info('[TallyQuotation] quotation-sync not enabled on plan — skipping');
      return { success: true, created: 0, skipped: 0 };
    }

    const orders = await getSalesOrders();
    if (!orders || orders.length === 0) {
      logger.info('[TallyQuotation] No Sales Orders found in Tally');
      return { success: true, created: 0, skipped: 0 };
    }

    const cache    = loadCache();
    const newCache = { ...cache };
    let created = 0, skipped = 0, failed = 0;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // Build product map ONCE before processing all orders
    const normalizeProductName = (str) =>
      (str || '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');   // keep hyphens/dots intact — exact name match

    const bitrixProductMap = {};
    try {
      const { fetchAllBitrixProducts } = require('./inventoryProcessor');
      const prods = await fetchAllBitrixProducts();
      prods.forEach(p => {
        const key = normalizeProductName(p.NAME);
        if (!bitrixProductMap[key]) {
          bitrixProductMap[key] = p;
        } else {
          const existing = bitrixProductMap[key];
          if (!existing.ID && p.ID) {
            bitrixProductMap[key] = p;
          } else if (existing.ID && p.ID && (!existing.PRICE || existing.PRICE == 0) && p.PRICE > 0) {
            bitrixProductMap[key] = p;
          }
        }
      });
      logger.info('[TallyQuotation] Product map built', { totalProducts: prods.length, uniqueKeys: Object.keys(bitrixProductMap).length });
    } catch (pmapErr) {
      logger.warn('[TallyQuotation] Failed to build product map — product rows will use names only', { message: pmapErr.message });
    }

    for (const order of orders) {
      try {
        const normalizedAmount = Math.round(order.amount);
        const cacheKey = `tally_${order.partyName}_${order.voucherNumber}_${normalizedAmount}`;

        if (cache[cacheKey]) { skipped++; continue; }

        // Guard: skip BX- prefixed vouchers — these were created from Bitrix24
        if (order.voucherNumber.startsWith('BX-')) { skipped++; continue; }

        const alreadyExists = await quotationExistsInBitrix(order.voucherNumber, order.partyName);
        if (alreadyExists) {
          newCache[cacheKey] = { bitrixId: null, syncedAt: new Date().toISOString(), source: 'dedup-check' };
          saveCache(newCache);
          skipped++;
          continue;
        }

        await sleep(300);

        const partyIds = await findBitrixParty(order.partyName);
        if (!partyIds.companyId && !partyIds.contactId) {
          logger.warn('[TallyQuotation] Party not found in Bitrix24 — skipping', {
            voucherNumber: order.voucherNumber, partyName: order.partyName,
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
              filter: { '%TITLE': order.partyName, CATEGORY_ID: categoryId, '=OPPORTUNITY': order.amount },
              select: ['ID', 'TITLE'],
            });
            if ((dealSearch.result || []).length > 0) dealId = dealSearch.result[0].ID;
          }
        } catch (_) {}

        // Build product rows from line items
        let productRows = [];
        if (order.items && order.items.length > 0) {
          try {
            for (const item of order.items) {
              const key = normalizeProductName(item.stockItemName);
              const mp = bitrixProductMap[key];
              if (mp && mp.ID) {
                logger.info('[Product Matched]', {
                  tallyName: item.stockItemName,
                  bitrixName: mp.NAME,
                  productId: mp.ID,
                });
                productRows.push({
                  PRODUCT_ID:  Number(mp.ID),
                  PRICE: item.rate > 0
                    ? item.rate
                    : (mp.PRICE && !isNaN(parseFloat(mp.PRICE)) ? parseFloat(mp.PRICE) : 0),
                  QUANTITY:    item.qty,
                  DISCOUNT:    0,
                  CURRENCY_ID: 'INR',
                });
              } else {
                logger.error('[Product Mapping Failed]', {
                  tallyName:     item.stockItemName,
                  normalizedKey: key,
                });
                productRows.push({
                  PRODUCT_NAME: item.stockItemName,
                  PRICE:        item.rate,
                  QUANTITY:     item.qty,
                  DISCOUNT:     0,
                  CURRENCY_ID:  'INR',
                });
              }
            }
          } catch (rowErr) {
            logger.warn('[TallyQuotation] Product row build failed', { message: rowErr.message });
          }
        }

        const estimateId = await pushOrderToBitrix(order, partyIds, dealId, productRows);

        if (!estimateId) {
          logger.error('[TallyQuotation] Estimate creation returned no ID', { voucherNumber: order.voucherNumber });
          failed++;
          continue;
        }

        newCache[cacheKey] = {
          bitrixId:      estimateId,
          syncedAt:      new Date().toISOString(),
          partyName:     order.partyName,
          voucherNumber: order.voucherNumber,
        };
        saveCache(newCache);

        logger.info('[TallyQuotation] Sales Order pushed to Bitrix24 as Estimate', {
          voucherNumber: order.voucherNumber,
          partyName:     order.partyName,
          amount:        order.amount,
          estimateId,
          lineItems:     productRows.length,
        });

        created++;
        await sleep(500);

      } catch (e) {
        logger.error('[TallyQuotation] Failed to push Sales Order', {
          voucherNumber: order.voucherNumber,
          message: e.message,
        });
        failed++;
      }
    }

    saveCache(newCache);
    logger.info('[TallyQuotation] Tally→Bitrix sync complete', { created, skipped, failed });
    return { success: true, created, skipped, failed };

  } catch (error) {
    if (error.message === 'TALLY_OFFLINE') {
      logger.warn('[TallyQuotation] Skipped — Tally offline');
      return { success: true, created: 0, skipped: 0 };
    }
    logger.error('[TallyQuotation] Tally→Bitrix sync failed', { message: error.message });
    throw error;
  }
}

module.exports = { processTallyQuotations, getSalesOrders };