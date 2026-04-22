const { getReceipts } = require('./paymentProcessor');
const { callBitrix }  = require('../connectors/bitrixConnector');
const { getTallyPipelineCategoryId } = require('../services/pipelineService');
const logger = require('../utils/logger');
const fs     = require('fs');
const path   = require('path');

const CACHE_PATH = path.join(__dirname, '../../logs/receipt-match-cache.json');

function loadCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {}
  return { lastRun: null, matched: [], unmatched: [] };
}

function saveCache(data) {
  try {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    logger.warn('[ReceiptMatcher] Cache save failed: ' + e.message);
  }
}

// Fetch all deals from Tally pipeline in Bitrix24
async function fetchPipelineDeals() {
  try {
    const categoryId = await getTallyPipelineCategoryId();
    if (!categoryId) return [];

    const allDeals = [];
    let start = 0;

    while (true) {
      const data = await callBitrix('crm.deal.list', {
        filter: { CATEGORY_ID: categoryId },
        select: ['ID', 'TITLE', 'OPPORTUNITY', 'STAGE_ID',
                 'UF_PAYMENT_STATUS', 'UF_OUTSTANDING', 'CLOSEDATE'],
        start,
      });
      const page = data.result || [];
      allDeals.push(...page);
      if (!data.next || page.length === 0) break;
      start = data.next;
    }

    return allDeals;
  } catch (e) {
    logger.warn('[ReceiptMatcher] Failed to fetch pipeline deals', { message: e.message });
    return [];
  }
}

// Match Tally receipts to Bitrix24 outstanding deals
async function matchReceiptsToOutstanding() {
  try {
    logger.info('[ReceiptMatcher] Starting receipt → outstanding match');

    const [receipts, deals] = await Promise.all([
      getReceipts(),
      fetchPipelineDeals(),
    ]);

    const matched   = [];
    const unmatched = [];

    // Build deal lookup by title parts
    const dealMap = {};
    for (const deal of deals) {
      const parts      = (deal.TITLE || '').split(' - ');
      const billRef    = parts[parts.length - 1]?.trim() || '';
      const partyPart  = parts.slice(0, -1).join(' - ').trim().toLowerCase();
      if (billRef) dealMap[billRef.toLowerCase()] = deal;
      if (partyPart) {
        if (!dealMap[partyPart]) dealMap[partyPart] = deal;
      }
    }

    for (const receipt of receipts) {
      let matchedDeal = null;

      // Try to match by bill reference first
      for (const ref of receipt.billRefs) {
        const key = ref.billName.toLowerCase();
        if (dealMap[key]) { matchedDeal = dealMap[key]; break; }
      }

      // Fallback — match by party name
      if (!matchedDeal) {
        const partyKey = receipt.partyName.toLowerCase();
        matchedDeal    = dealMap[partyKey] || null;
      }

      if (matchedDeal) {
        const dealAmount    = parseFloat(matchedDeal.OPPORTUNITY) || 0;
        const receiptAmount = receipt.amount || 0;
        const outstanding   = Math.max(0, dealAmount - receiptAmount);
        const isFullyPaid   = outstanding < 1;

        matched.push({
          receipt: {
            partyName:     receipt.partyName,
            voucherNumber: receipt.voucherNumber,
            date:          receipt.date,
            amount:        receiptAmount,
            billRefs:      receipt.billRefs,
          },
          deal: {
            id:          matchedDeal.ID,
            title:       matchedDeal.TITLE,
            dealAmount,
            stage:       matchedDeal.STAGE_ID,
          },
          outstanding,
          isFullyPaid,
          status: isFullyPaid ? 'Fully Paid' : 'Partial',
        });
      } else {
        unmatched.push({
          partyName:     receipt.partyName,
          voucherNumber: receipt.voucherNumber,
          date:          receipt.date,
          amount:        receipt.amount,
          reason:        'No matching deal found in Bitrix24',
        });
      }
    }

    // Write outstanding balance back to each matched deal in Bitrix24
    for (const m of matched) {
      try {
        await callBitrix('crm.deal.update', {
          id:     m.deal.id,
          fields: {
            UF_OUTSTANDING:     m.outstanding,
            UF_PAYMENT_STATUS:  m.isFullyPaid ? 'Paid' : 'Partial',
            UF_PAYMENT_AMOUNT:  m.receipt.amount,
            UF_PAYMENT_DATE:    m.receipt.date,
            UF_RECEIPT_NUMBER:  m.receipt.voucherNumber,
          },
        });
        logger.info('[ReceiptMatcher] Outstanding writeback done', {
          dealId:      m.deal.id,
          outstanding: m.outstanding,
          status:      m.isFullyPaid ? 'Paid' : 'Partial',
        });

        // Find and update the linked Smart Invoice for this voucher/deal
        try {
          // Search by voucher number first
          let invoiceId = null;
          try {
            const invSearch = await callBitrix('crm.item.list', {
              entityTypeId: 31,
              filter: { 'UF_TALLY_VOUCHER_NO': m.receipt.billRefs?.[0]?.billName || '' },
              select: ['id'],
            });
            if ((invSearch.result?.items?.length ?? 0) > 0) {
              invoiceId = invSearch.result.items[0].id;
            }
          } catch (_) {}

          // Fallback: search by deal link (parentId2)
          if (!invoiceId) {
            try {
              const invByDeal = await callBitrix('crm.item.list', {
                entityTypeId: 31,
                filter: { 'parentId2': m.deal.id },
                select: ['id', 'title'],
              });
              if ((invByDeal.result?.items?.length ?? 0) > 0) {
                invoiceId = invByDeal.result.items[0].id;
              }
            } catch (_) {}
          }

          // Fallback: search by title matching party - billref
          if (!invoiceId && m.receipt.billRefs?.length > 0) {
            try {
              const titleSearch = await callBitrix('crm.item.list', {
                entityTypeId: 31,
                filter: { '=title': `${m.receipt.partyName} - ${m.receipt.billRefs[0].billName}` },
                select: ['id'],
              });
              if ((titleSearch.result?.items?.length ?? 0) > 0) {
                invoiceId = titleSearch.result.items[0].id;
              }
            } catch (_) {}
          }

          if (invoiceId) {
            await callBitrix('crm.item.update', {
              entityTypeId: 31,
              id:           Number(invoiceId),
              fields: {
                UF_PAYMENT_STATUS:  m.isFullyPaid ? 'Paid' : 'Partial',
                UF_PAYMENT_AMOUNT:  m.receipt.amount,
                UF_PAYMENT_DATE:    m.receipt.date,
                UF_RECEIPT_NUMBER:  m.receipt.voucherNumber,
                UF_OUTSTANDING:     m.outstanding,
              },
            });
            
            logger.info('[ReceiptMatcher] Receipt attached to invoice', {
              invoiceId,
              receiptNumber: m.receipt.voucherNumber,
              amount: m.receipt.amount,
            });
          } else {
            logger.info('[ReceiptMatcher] No linked invoice found for deal — skipping invoice update', {
              dealId: m.deal.id,
              partyName: m.receipt.partyName,
            });
          }
        } catch (invErr) {
          logger.warn('[ReceiptMatcher] Invoice update failed — non-fatal', {
            dealId: m.deal.id, message: invErr.message,
          });
        }

        // If fully paid — move deal to Won
        if (m.isFullyPaid) {
          await callBitrix('crm.deal.update', {
            id:     m.deal.id,
            fields: { STAGE_ID: 'WON' },
          });
          logger.info('[ReceiptMatcher] Deal marked WON — fully paid', { dealId: m.deal.id });
        }
      } catch (e) {
        logger.warn('[ReceiptMatcher] Outstanding writeback failed', {
          dealId: m.deal.id, message: e.message,
        });
      }
    }

    const result = {
      lastRun:   new Date().toISOString(),
      total:     receipts.length,
      matched:   matched.length,
      unmatched: unmatched.length,
      matchedList:   matched,
      unmatchedList: unmatched,
    };

    saveCache(result);

    logger.info('[ReceiptMatcher] Match completed', {
      matched:   matched.length,
      unmatched: unmatched.length,
    });

    return result;

  } catch (error) {
    if (error.message === 'TALLY_OFFLINE') {
      logger.warn('[ReceiptMatcher] Skipped — Tally offline');
      return loadCache();
    }
    logger.error('[ReceiptMatcher] Failed', { message: error.message });
    throw error;
  }
}

function getLastMatchResult() {
  return loadCache();
}

module.exports = { matchReceiptsToOutstanding, getLastMatchResult };