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
    const searchTitle = billRef
      ? `${partyName} - ${billRef}`
      : partyName;

    const data = await callBitrix('crm.deal.list', {
      filter: {
        '%TITLE': searchTitle,
        ...(categoryId ? { CATEGORY_ID: categoryId } : {}),
      },
      select: ['ID', 'TITLE', 'OPPORTUNITY', 'STAGE_ID', 'UF_PAYMENT_STATUS'],
    });
    const deals = data.result || [];
    return deals[0] || null;
  } catch (e) {
    logger.warn('Deal search failed', { partyName, billRef, message: e.message });
    return null;
  }
}

// Update deal payment status in Bitrix24
async function updateDealPaymentStatus(deal, receipt, isFullyPaid) {
  const dealId = deal.ID;
  const dealAmount = parseFloat(deal.OPPORTUNITY) || 0;
  try {
    const categoryId = await getTallyPipelineCategoryId();
    const stagesData = await callBitrix('crm.dealcategory.stage.list', { id: categoryId });
    const stages     = stagesData.result || [];

    const stageMap = {};
    stages.forEach(s => {
      stageMap[(s.NAME || '').toLowerCase()] = s.STATUS_ID;
    });

    const fields = {
      UF_PAYMENT_STATUS:   isFullyPaid ? 'Paid' : 'Partial',
      UF_PAYMENT_DATE:     receipt.date,
      UF_PAYMENT_AMOUNT:   receipt.amount,
      UF_RECEIPT_NUMBER:   receipt.voucherNumber,
      UF_OUTSTANDING:      Math.max(0, dealAmount - receipt.amount),
    };

    // Move to correct stage
    if (isFullyPaid && stageMap['deal won']) {
      fields.STAGE_ID = stageMap['deal won'];
    } else if (!isFullyPaid && stageMap['follow up']) {
      fields.STAGE_ID = stageMap['follow up'];
    }

    await callBitrix('crm.deal.update', { id: dealId, fields });
    logger.info('Deal payment status updated', {
      dealId, status: fields.UF_PAYMENT_STATUS, stage: fields.STAGE_ID,
    });
  } catch (e) {
    logger.error('Failed to update deal payment status', { dealId, message: e.message });
    throw e;
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
          
          // If no deal found but we have receipt — create invoice in Tally, then deal in Bitrix
          if (!deal && ref.amount > 0) {
            try {
              // First create invoice in Tally (if doesn't exist)
              const invoiceName = ref.billName || `RX-${receipt.voucherNumber}`;
              const invoiceCreated = await createInvoiceInTally(
                receipt.partyName,
                invoiceName,
                ref.amount,
                receipt.date
              );
              
              // Find company in Bitrix
              const company = await findCompanyByName(receipt.partyName);
              if (company) {
                const categoryId = await getTallyPipelineCategoryId();
                const dealTitle = ref.billName 
                  ? `${receipt.partyName} - ${ref.billName}`
                  : `${receipt.partyName} - Receipt ${receipt.voucherNumber}`;
                
                const newDeal = await callBitrix('crm.deal.add', {
                  fields: {
                    TITLE: dealTitle,
                    OPPORTUNITY: ref.amount,
                    COMPANY_ID: company.ID,
                    CATEGORY_ID: categoryId,
                    STAGE_ID: 'WON',
                    UF_PAYMENT_STATUS: 'Paid',
                    UF_RECEIPT_NUMBER: receipt.voucherNumber,
                    UF_PAYMENT_DATE: receipt.date,
                    UF_PAYMENT_AMOUNT: ref.amount,
                    UF_BILL_DATE: receipt.date,
                    UF_INVOICE_NUMBER: ref.billName || `TALLY-${receipt.voucherNumber}`,
                  }
                });
                
                deal = { ID: newDeal.result, TITLE: dealTitle, OPPORTUNITY: ref.amount };
                logger.info('Deal auto-created from Tally receipt', {
                  dealId: deal.ID,
                  partyName: receipt.partyName,
                  amount: ref.amount,
                  voucherNumber: receipt.voucherNumber,
                });
              }
            } catch (createErr) {
              logger.error('Failed to auto-create deal from receipt', {
                partyName: receipt.partyName,
                message: createErr.message,
              });
            }
          }
          
          if (!deal) {
            logger.info('No matching deal found for receipt', {
              partyName: receipt.partyName,
              billRef:   ref.billName,
            });
            skipped++;
            continue;
          }

          // Determine if fully paid
          const dealAmount    = parseFloat(deal.OPPORTUNITY) || 0;
          const isFullyPaid   = ref.amount >= dealAmount * 0.99; // 1% tolerance

          await updateDealPaymentStatus(deal, receipt, isFullyPaid);

          // If fully paid — mark deal WON
          if (isFullyPaid) {
            await callBitrix('crm.deal.update', {
              id:     deal.ID,
              fields: { STAGE_ID: 'WON' },
            });
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

module.exports = { processPayments, getReceipts };