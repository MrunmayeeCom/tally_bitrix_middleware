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
                 'UF_PAYMENT_STATUS', 'UF_OUTSTANDING', 'CLOSEDATE', 'UF_INVOICE_NUMBER'],
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

    // Build deal lookup by title parts AND UF_INVOICE_NUMBER field
    const dealMap = {};
    for (const deal of deals) {
      // Use UF_INVOICE_NUMBER if available
      const invoiceNum = deal.UF_INVOICE_NUMBER;
      if (invoiceNum) {
        const key = String(invoiceNum).toLowerCase().trim();
        dealMap[key] = deal;
        // Also add without BX- prefix
        const normKey = key.replace(/^bx-/i, '');
        if (normKey !== key) dealMap[normKey] = deal;
      }
      
      // Also use bill ref from title
      const parts      = (deal.TITLE || '').split(' - ');
      let billRef      = parts[parts.length - 1]?.trim() || '';
      const normalizedBillRef = billRef.replace(/^BX-/i, '');
      const partyPart  = parts.slice(0, -1).join(' - ').trim().toLowerCase();
      if (billRef) {
        if (!dealMap[billRef.toLowerCase()]) dealMap[billRef.toLowerCase()] = deal;
        if (normalizedBillRef !== billRef && !dealMap[normalizedBillRef.toLowerCase()]) {
          dealMap[normalizedBillRef.toLowerCase()] = deal;
        }
      }
      if (partyPart) {
        if (!dealMap[partyPart]) dealMap[partyPart] = deal;
      }
    }

    for (const receipt of receipts) {
      let matchedDeal = null;
      let matchReason = '';
      const partyKey = receipt.partyName.toLowerCase();
      const categoryId = await getTallyPipelineCategoryId();

      // PRIMARY: Match using Smart Invoice by accountNumber (BX-3481 → accountNumber: 3481)
      for (const ref of receipt.billRefs) {
        const billRef = ref.billName.trim();
        const accountNumber = billRef.replace(/^BX-/i, '');
        if (!accountNumber || !/^\d+$/.test(accountNumber)) continue;
        
        try {
          // Search Smart Invoice by accountNumber field
          const invoiceData = await callBitrix('crm.item.list', {
            entityTypeId: 31,
            filter: { 'accountNumber': accountNumber },
            select: ['id', 'parentId2', 'title'],
          });
          const invoice = invoiceData.result?.items?.[0];
          
          if (invoice) {
            // If parentId2 exists, use it directly
            if (invoice.parentId2) {
              const dealData = await callBitrix('crm.deal.get', {
                id: parseInt(invoice.parentId2),
              });
              if (dealData.result) {
                matchedDeal = dealData.result;
                matchReason = 'smartInvoice';
                break;
              }
            }
            
            // FALLBACK: parentId2 is null - extract voucher from invoice title and search deal
            if (invoice.title) {
              const titleParts = invoice.title.split(' - ');
              const voucherNum = titleParts[titleParts.length - 1]?.trim();
              if (voucherNum && categoryId) {
                const dealSearchTitle = `${receipt.partyName} - ${voucherNum}`;
                const dealSearch = await callBitrix('crm.deal.list', {
                  filter: {
                    'TITLE': dealSearchTitle,
                    CATEGORY_ID: categoryId,
                  },
                  select: ['ID', 'TITLE', 'OPPORTUNITY', 'STAGE_ID'],
                });
                if (dealSearch.result?.length > 0) {
                  matchedDeal = dealSearch.result[0];
                  matchReason = 'invoiceTitle';
                  break;
                }
              }
            }
          }
        } catch (e) {
          // Smart Invoice not found, continue to fallback
        }
      }

      // FALLBACK: Match by bill reference in deal map
      if (!matchedDeal) {
        for (const ref of receipt.billRefs) {
          let key = ref.billName.toLowerCase();
          if (dealMap[key]) { 
            matchedDeal = dealMap[key]; 
            matchReason = 'billRef';
            break; 
          }
          const normalizedKey = key.replace(/^bx-/i, '');
          if (dealMap[normalizedKey]) { 
            matchedDeal = dealMap[normalizedKey]; 
            matchReason = 'billRef';
            break; 
          }
        }
      }

      // FALLBACK 2: Match by party name + amount
      if (!matchedDeal) {
        const partyKey = receipt.partyName.toLowerCase();
        const receiptAmt = receipt.amount || 0;
        const dealsForParty = deals.filter(d => 
          (d.TITLE || '').toLowerCase().startsWith(partyKey)
        );
        
        const amountMatchedDeal = dealsForParty.find(d => {
          const dealAmt = parseFloat(d.OPPORTUNITY) || 0;
          if (dealAmt <= 0) return false;
          const tolerance = dealAmt * 0.05;
          return receiptAmt >= (dealAmt - tolerance);
        });
        
        if (amountMatchedDeal) {
          matchedDeal = amountMatchedDeal;
          matchReason = 'party+amount';
        } else if (dealsForParty.length === 1 && receiptAmt >= parseFloat(dealsForParty[0].OPPORTUNITY || 0)) {
          matchedDeal = dealsForParty[0];
          matchReason = 'party+amount';
        } else if (dealsForParty.length > 1) {
          logger.warn('[ReceiptMatcher] Multiple deals for party', {
            partyName: receipt.partyName,
            receiptAmount: receiptAmt,
            deals: dealsForParty.map(d => d.ID)
          });
        }
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

        // If fully paid — move deal to Won and also move invoice to Won stage
        if (m.isFullyPaid) {
          const categoryId = await getTallyPipelineCategoryId();
          const statusData = await callBitrix('crm.status.list', {
            filter: { ENTITY_ID: `DEAL_STAGE_${categoryId}` }
          });
          const stages = statusData.result || [];
          const stageMap = {};
          stages.forEach(s => {
            stageMap[(s.NAME || s.name || '').toLowerCase()] = s.STATUS_ID || s.statusId;
          });
          const wonStageId = stageMap['deal won'] || 'C542:WON';
          
          await callBitrix('crm.deal.update', {
            id:     m.deal.id,
            fields: { STAGE_ID: wonStageId },
          });
          
          // Also move linked invoice to Won stage
          if (invoiceId) {
            await moveInvoiceToWonStage(invoiceId);
          }
          
          logger.info('[ReceiptMatcher] Deal marked WON — fully paid', { dealId: m.deal.id });
        }
        
        // Attach receipt to deal timeline
        try {
          await attachReceiptToDeal(m.deal.id, m.receipt);
        } catch (attachErr) {
          logger.warn('[ReceiptMatcher] Failed to attach receipt to deal', {
            dealId: m.deal.id,
            message: attachErr.message
          });
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

// Move Smart Invoice to Won/Completed stage
async function moveInvoiceToWonStage(invoiceId) {
  try {
    // Get the Won stage ID for Smart Invoices
    const stagesData = await callBitrix('crm.item.fields', {
      entityTypeId: 31,
    });
    const stageField = stagesData.result?.fields?.stageId;
    const stageOptions = stageField?.settings?.options || [];
    
    // Find 'Successfully Completed' or 'Won' stage
    let wonStageId = null;
    for (const stage of stageOptions) {
      const name = (stage.name || '').toLowerCase();
      if (name.includes('successfully') || name.includes('won') || name.includes('completed')) {
        wonStageId = stage.statusId;
        break;
      }
    }
    
    // If no custom stage found, try default WON stage
    if (!wonStageId) {
      wonStageId = 'SUCCESSFULLY_COMPLETED';
    }
    
    await callBitrix('crm.item.update', {
      entityTypeId: 31,
      id: invoiceId,
      fields: {
        stageId: wonStageId,
        UF_PAYMENT_STATUS: 'Paid',
      },
    });
    
    logger.info('[ReceiptMatcher] Invoice moved to Won stage', {
      invoiceId,
      stageId: wonStageId,
    });
  } catch (e) {
    logger.warn('[ReceiptMatcher] Failed to move invoice to Won stage', {
      invoiceId,
      message: e.message
    });
  }
}

module.exports = { matchReceiptsToOutstanding, getLastMatchResult };