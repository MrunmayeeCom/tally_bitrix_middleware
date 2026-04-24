const { sendToTally } = require('../connectors/tallyConnector');
const { callBitrix } = require('../connectors/bitrixConnector');
const { getTallyPipelineCategoryId } = require('../services/pipelineService');
const tallyConfig = require('../config/tallyConfig');
const logger = require('../utils/logger');

function escapeXml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Create Invoice in Tally when Receipt comes first (no existing invoice)
async function createInvoiceInTally(partyName, invoiceNumber, amount, date) {
  try {
    const formattedDate = date.replace(/-/g, '');
    
    const xml = `
      <ENVELOPE>
        <HEADER>
          <TALLYREQUEST>Import Data</TALLYREQUEST>
        </HEADER>
        <BODY>
          <IMPORTDATA>
            <REQUESTDESC>
              <REPORTNAME>Vouchers</REPORTNAME>
              <STATICVARIABLES>
                <SVCURRENTCOMPANY>${tallyConfig.company}</SVCURRENTCOMPANY>
              </STATICVARIABLES>
            </REQUESTDESC>
            <REQUESTDATA>
              <TALLYMESSAGE xmlns:UDF="TallyUDF">
                <VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Invoice Voucher View">
                  <DATE>${formattedDate}</DATE>
                  <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
                  <VOUCHERNUMBER>${invoiceNumber}</VOUCHERNUMBER>
                  <REFERENCE>${invoiceNumber}</REFERENCE>
                  <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
                  <ISINVOICE>Yes</ISINVOICE>
                  <PARTYLEDGERNAME>${partyName}</PARTYLEDGERNAME>
                  <NARRATION>Auto-created from Receipt ${invoiceNumber}</NARRATION>
                  <ALLLEDGERENTRIES.LIST>
                    <LEDGERNAME>${partyName}</LEDGERNAME>
                    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
                    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
                    <ISLASTDEEMEDPOSITIVE>Yes</ISLASTDEEMEDPOSITIVE>
                    <AMOUNT>-${amount}</AMOUNT>
                    <BILLALLOCATIONS.LIST>
                      <NAME>${invoiceNumber}</NAME>
                      <BILLTYPE>New Ref</BILLTYPE>
                      <AMOUNT>-${amount}</AMOUNT>
                    </BILLALLOCATIONS.LIST>
                  </ALLLEDGERENTRIES.LIST>
                  <ALLLEDGERENTRIES.LIST>
                    <LEDGERNAME>Sales</LEDGERNAME>
                    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
                    <AMOUNT>${amount}</AMOUNT>
                  </ALLLEDGERENTRIES.LIST>
                </VOUCHER>
              </TALLYMESSAGE>
            </REQUESTDATA>
          </IMPORTDATA>
        </BODY>
      </ENVELOPE>`.trim();

    const response = await sendToTally(xml);
    const created = response.includes('<CREATED>1</CREATED>') || response.includes('<CREATED>1</CREATED>');
    
    logger.info('Auto-created invoice in Tally from receipt', {
      invoiceNumber,
      partyName,
      amount,
      created
    });
    
    return created;
  } catch (err) {
    logger.error('Failed to auto-create invoice in Tally', {
      invoiceNumber,
      partyName,
      message: err.message
    });
    return false;
  }
}

// Fetch receipts from Tally (payment received vouchers)
async function getReceipts() {
  logger.info('Fetching receipts from Tally');

  const today    = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 30);

  const fmt = (d) => {
    const dd   = String(d.getDate()).padStart(2, '0');
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  };

  const xml = `
    <ENVELOPE>
      <HEADER>
        <TALLYREQUEST>Export Data</TALLYREQUEST>
      </HEADER>
      <BODY>
        <EXPORTDATA>
          <REQUESTDESC>
            <REPORTNAME>Day Book</REPORTNAME>
            <STATICVARIABLES>
              <SVCURRENTCOMPANY>${tallyConfig.company}</SVCURRENTCOMPANY>
              <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
              <SVFROMDATE>${fmt(fromDate)}</SVFROMDATE>
              <SVTODATE>${fmt(today)}</SVTODATE>
            </STATICVARIABLES>
          </REQUESTDESC>
        </EXPORTDATA>
      </BODY>
    </ENVELOPE>
  `.trim();

  const response = await sendToTally(xml);
  return parseReceiptsXml(response);
}

// Parse receipts from Day Book XML
function parseReceiptsXml(xml) {
  try {
    const receipts = [];
    const voucherRegex = /<VOUCHER\b([^>]*)>([\s\S]*?)<\/VOUCHER>/gi;
    let match;

    while ((match = voucherRegex.exec(xml)) !== null) {
      const attrs = match[1];
      const block = match[2];

      const get = (tag) => {
        const m = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'i').exec(block);
        return m ? m[1].trim() : '';
      };

      const voucherType = get('VOUCHERTYPENAME') || '';
      if (!voucherType.toLowerCase().includes('receipt')) continue;

      const partyName     = get('PARTYLEDGERNAME') || '';
      const voucherNumber = get('VOUCHERNUMBER')   || '';
      const dateRaw       = get('DATE')             || '';
      const amount        = Math.abs(parseFloat(get('AMOUNT')) || 0);

      // Extract bill references paid in this receipt
      const billRefs = [];
      const billRefRegex = /<BILLALLOCATIONS\.LIST>([\s\S]*?)<\/BILLALLOCATIONS\.LIST>/gi;
      let billMatch;
      while ((billMatch = billRefRegex.exec(block)) !== null) {
        const billBlock = billMatch[1];
        const billName  = (/<NAME>(.*?)<\/NAME>/i.exec(billBlock) || [])[1]?.trim() || '';
        const billAmt   = Math.abs(parseFloat((/<AMOUNT>(.*?)<\/AMOUNT>/i.exec(billBlock) || [])[1]) || 0);
        if (billName) billRefs.push({ billName, amount: billAmt });
      }

      if (!partyName || amount === 0) continue;

      receipts.push({
        partyName,
        voucherNumber,
        date: dateRaw.length === 8
          ? `${dateRaw.slice(0,4)}-${dateRaw.slice(4,6)}-${dateRaw.slice(6,8)}`
          : dateRaw,
        amount,
        billRefs,
      });
    }

    logger.info(`Parsed ${receipts.length} receipts from Tally`);
    return receipts;
  } catch (err) {
    logger.error('Failed to parse receipts XML', { message: err.message });
    return [];
  }
}

// Find Bitrix24 company by name
async function findCompanyByName(companyName) {
  try {
    const data = await callBitrix('crm.company.list', {
      filter: { '%TITLE': companyName },
      select: ['ID', 'TITLE'],
    });
    const companies = data.result || [];
    return companies[0] || null;
  } catch (e) {
    logger.warn('Company search failed', { companyName, message: e.message });
    return null;
  }
}

// Find Bitrix24 deal by party name and bill reference
async function findDealByBillRef(partyName, billRef) {
  try {
    const categoryId = await getTallyPipelineCategoryId();
    
    // PRIMARY: Use Smart Invoice lookup by accountNumber (BX-3481 → accountNumber: 3481)
    if (billRef) {
      const accountNumber = billRef.replace(/^BX-/i, '').trim();
      if (/^\d+$/.test(accountNumber)) {
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
                logger.info('[PaymentProcessor] Found deal via Smart Invoice parentId2', {
                  accountNumber,
                  dealId: dealData.result.ID,
                  title: dealData.result.TITLE,
                });
                return dealData.result;
              }
            }
            
            // FALLBACK: parentId2 is null - extract voucher from invoice title and search deal
            if (invoice.title) {
              const titleParts = invoice.title.split(' - ');
              const voucherNum = titleParts[titleParts.length - 1]?.trim();
              if (voucherNum && categoryId) {
                // Search for deal with exact title "partyName - voucherNum"
                const dealSearchTitle = `${partyName} - ${voucherNum}`;
                const dealSearch = await callBitrix('crm.deal.list', {
                  filter: {
                    'TITLE': dealSearchTitle,
                    CATEGORY_ID: categoryId,
                  },
                  select: ['ID', 'TITLE', 'OPPORTUNITY', 'STAGE_ID'],
                });
                if (dealSearch.result?.length > 0) {
                  logger.info('[PaymentProcessor] Found deal via invoice title fallback', {
                    accountNumber,
                    dealTitle: dealSearchTitle,
                    dealId: dealSearch.result[0].ID,
                  });
                  return dealSearch.result[0];
                }
              }
            }
          }
        } catch (e) {
          logger.warn('[PaymentProcessor] Smart Invoice lookup failed', { accountNumber, error: e.message });
        }
      }
    }
    
    // FALLBACK: Search by party name - only if exactly 1 open deal exists
    const partialData = await callBitrix('crm.deal.list', {
      filter: {
        '%TITLE': partyName,
        ...(categoryId ? { CATEGORY_ID: categoryId } : {}),
      },
      select: ['ID', 'TITLE', 'OPPORTUNITY', 'STAGE_ID', 'UF_PAYMENT_STATUS'],
      order: { STAGE_ID: 'ASC' },
    });
    const partialDeals = partialData.result || [];
    
    // Filter to only open (non-WON) deals
    const openDeals = partialDeals.filter(d => !d.STAGE_ID?.includes('WON'));
    
    if (openDeals.length === 1) {
      logger.info('[PaymentProcessor] Found deal by party name (single open deal)', {
        dealId: openDeals[0].ID,
        title: openDeals[0].TITLE,
      });
      return openDeals[0];
    } else if (openDeals.length > 1) {
      logger.warn('[PaymentProcessor] Multiple open deals for party - cannot auto-match', {
        partyName,
        deals: openDeals.map(d => d.ID),
      });
      return null;
    }
    
    // No open deals - return null (do not guess with WON deals)
    logger.warn('[PaymentProcessor] No open deal found for party', { partyName });
    return null;
  } catch (e) {
    logger.warn('Deal search failed', { partyName, billRef, message: e.message });
    return null;
  }
}

// Update deal payment status in Bitrix24
async function updateDealPaymentStatus(deal, receipt, isFullyPaid, wonStageId) {
  const dealId = deal.ID;
  const dealAmount = parseFloat(deal.OPPORTUNITY) || 0;
  try {
    const categoryId = await getTallyPipelineCategoryId();
    const stagesData = await callBitrix('crm.dealcategory.stage.list', { id: categoryId });
    const stages = stagesData.result || [];

    const stageMap = {};
    stages.forEach(s => {
      stageMap[(s.NAME || '').toLowerCase()] = s.STAGE_ID;
    });

    const wonStage = wonStageId || stageMap['deal won'] || 'WON';

    const fields = {
      UF_PAYMENT_STATUS:   isFullyPaid ? 'Paid' : 'Partial',
      UF_PAYMENT_DATE:    receipt.date,
      UF_PAYMENT_AMOUNT:  receipt.amount,
      UF_RECEIPT_NUMBER:   receipt.voucherNumber,
      UF_OUTSTANDING:     Math.max(0, dealAmount - receipt.amount),
    };

    // Move to correct stage
    if (isFullyPaid && wonStage) {
      fields.STAGE_ID = wonStage;
    } else if (!isFullyPaid && stageMap['follow up']) {
      fields.STAGE_ID = stageMap['follow up'];
    }

    await callBitrix('crm.deal.update', { id: dealId, fields });
    
    // Also update linked Smart Invoice
    await updateLinkedInvoice(dealId, receipt, isFullyPaid);
    
    logger.info('Deal payment status updated', {
      dealId, status: fields.UF_PAYMENT_STATUS, stage: fields.STAGE_ID,
    });
  } catch (e) {
    logger.error('Failed to update deal payment status', { dealId, message: e.message });
    throw e;
  }
}

// Update Smart Invoice linked to this deal
async function updateLinkedInvoice(dealId, receipt, isFullyPaid) {
  try {
    // Find invoice linked to this deal via parentId2
    const invoiceSearch = await callBitrix('crm.item.list', {
      entityTypeId: 31,
      filter: { 'parentId2': Number(dealId) },
      select: ['id', 'title', 'stageId'],
    });
    
    const invoices = invoiceSearch.result?.items || [];
    if (invoices.length === 0) {
      logger.info('No linked invoice found for deal', { dealId });
      return;
    }
    
    // Update each linked invoice
    for (const invoice of invoices) {
      const invoiceId = invoice.id;
      const dealAmount = parseFloat(invoice.opportunity) || parseFloat(invoice.OPPORTUNITY) || 0;
      
      // Update invoice with payment fields
      const invoiceFields = {
        UF_PAYMENT_STATUS:   isFullyPaid ? 'Paid' : 'Partial',
        UF_PAYMENT_AMOUNT:  receipt.amount,
        UF_PAYMENT_DATE:    receipt.date,
        UF_RECEIPT_NUMBER:  receipt.voucherNumber,
        UF_OUTSTANDING:     Math.max(0, dealAmount - receipt.amount),
      };
      
      await callBitrix('crm.item.update', {
        entityTypeId: 31,
        id: invoiceId,
        fields: invoiceFields,
      });
      
      logger.info('Linked invoice updated with payment info', {
        invoiceId,
        dealId,
        status: isFullyPaid ? 'Paid' : 'Partial',
        receiptNumber: receipt.voucherNumber,
      });
}
  
  } catch (e) {
    logger.warn('Failed to update linked invoice', { dealId, message: e.message });
  }
}

// Move linked Smart Invoice to Won/Completed stage
async function moveInvoiceToWonStage(dealId) {
  try {
    // Find invoice linked to this deal
    const invoiceSearch = await callBitrix('crm.item.list', {
      entityTypeId: 31,
      filter: { 'parentId2': Number(dealId) },
      select: ['id', 'title', 'stageId'],
    });
    
    const invoices = invoiceSearch.result?.items || [];
    if (invoices.length === 0) {
      logger.info('No linked invoice found for deal WON', { dealId });
      return;
    }
    
    // Get the Won stage ID for Smart Invoices
    const categoryId = await getTallyPipelineCategoryId();
    if (!categoryId) return;
    
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
    
    // Update each linked invoice
    for (const invoice of invoices) {
      await callBitrix('crm.item.update', {
        entityTypeId: 31,
        id: invoice.id,
        fields: {
          stageId: wonStageId,
          UF_PAYMENT_STATUS: 'Paid',
        },
      });
      
      logger.info('Linked invoice moved to Won stage', {
        invoiceId: invoice.id,
        dealId,
        stageId: wonStageId,
      });
    }
  } catch (e) {
    logger.warn('Failed to move linked invoice to Won stage', { dealId, message: e.message });
  }
}

// Attach receipt to deal documents/timeline
async function attachReceiptToDeal(dealId, receipt) {
  try {
    // Create a timeline activity with receipt details
    const description = `Payment Receipt Details:
- Receipt No: ${receipt.voucherNumber}
- Date: ${receipt.date}
- Amount: ${receipt.amount}
- Party: ${receipt.partyName}
${receipt.billRefs.length > 0 ? `- Against Invoice: ${receipt.billRefs.map(r => r.billName).join(', ')}` : ''}`;

    await callBitrix('crm.activity.add', {
      fields: {
        OWNER_TYPE_ID: 2, // Deal
        OWNER_ID: Number(dealId),
        TYPE_ID: 2, // Task/Activity
        SUBJECT: `Receipt ${receipt.voucherNumber} - Payment Received`,
        DESCRIPTION: description,
        DESCRIPTION_TYPE: 3, // Text
        PRIORITY: 3, // Normal
        RESPONSIBLE_ID: 1,
        COMPLETED: 'Y', // Mark as completed since it's a record of payment
      },
    });

    logger.info('[PaymentProcessor] Receipt attached to deal timeline', {
      dealId,
      receiptNumber: receipt.voucherNumber,
      amount: receipt.amount,
    });
  } catch (e) {
    logger.warn('Failed to attach receipt to deal', { dealId, message: e.message });
  }
}

// Main payment processor
async function processPayments() {
  try {
    logger.info('Payment sync started');

    const receipts = await getReceipts();

    if (!receipts || receipts.length === 0) {
      logger.info('No receipts found in Tally');
      return { success: true, processed: 0, skipped: 0 };
    }

    const categoryId = await getTallyPipelineCategoryId();
    const statusData = await callBitrix('crm.status.list', {
      filter: { ENTITY_ID: `DEAL_STAGE_${categoryId}` }
    });
    const stages = statusData.result || [];
    const stageMap = {};
    stages.forEach(s => {
      stageMap[(s.NAME || s.name || '').toLowerCase()] = s.STATUS_ID || s.statusId;
    });
    const wonStageId = stageMap['deal won'] || 'WON';

    logger.info(`Processing ${receipts.length} receipts`);

    let processed = 0;
    let skipped   = 0;
    let failed    = 0;

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    for (const receipt of receipts) {
      try {
        // Try each bill reference in this receipt
        const refs = receipt.billRefs.length > 0
          ? receipt.billRefs
          : [{ billName: '', amount: receipt.amount }];

        for (const ref of refs) {
          let deal = await findDealByBillRef(receipt.partyName, ref.billName);
          
          // No matching deal found - just skip (don't create new deals automatically)
          // This prevents creating deals when an existing invoice/deal wasn't found
          if (!deal) {
            logger.info('No matching deal found for receipt - skipping to avoid duplicate creation', {
              partyName: receipt.partyName,
              billRef:   ref.billName,
            });
            skipped++;
            continue;
          }

          // Determine if fully paid
          const dealAmount    = parseFloat(deal.OPPORTUNITY) || 0;
          const isFullyPaid   = ref.amount >= dealAmount * 0.99; // 1% tolerance

          await updateDealPaymentStatus(deal, receipt, isFullyPaid, wonStageId);

          // Attach receipt to deal timeline
          await attachReceiptToDeal(deal.ID, receipt);

          // If fully paid — mark deal WON
          if (isFullyPaid) {
            await callBitrix('crm.deal.update', {
              id:     deal.ID,
              fields: { STAGE_ID: wonStageId },
            });
            
            // Also move linked invoice to Won/Completed stage
            await moveInvoiceToWonStage(deal.ID);
            
            logger.info('Deal marked WON — full payment received', {
              dealId: deal.ID, title: deal.TITLE, amount: ref.amount,
            });
          }

          processed++;
          await sleep(300);
        }
      } catch (receiptErr) {
        logger.error('Failed to process receipt', {
          partyName: receipt.partyName,
          message:   receiptErr.message,
        });
        failed++;
      }
    }

    logger.info('Payment sync completed', { processed, skipped, failed });
    return { success: true, processed, skipped, failed };

  } catch (error) {
    if (error.message === 'TALLY_OFFLINE') {
      logger.warn('Payment sync skipped — Tally is not running');
      return { success: true, processed: 0, skipped: 0 };
    }
    logger.error('Payment processor failed', { message: error.message });
    throw error;
  }
}

module.exports = { processPayments, getReceipts, attachReceiptToDeal };