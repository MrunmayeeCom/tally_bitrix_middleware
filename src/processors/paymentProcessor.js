const { sendToTally } = require('../connectors/tallyConnector');
const { callBitrix } = require('../connectors/bitrixConnector');
const { getTallyPipelineCategoryId } = require('../services/pipelineService');
const tallyConfig = require('../config/tallyConfig');
const logger = require('../utils/logger');

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
async function updateDealPaymentStatus(dealId, receipt, isFullyPaid) {
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
    if (isFullyPaid && stageMap['payment received']) {
      fields.STAGE_ID = stageMap['payment received'];
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
          const deal = await findDealByBillRef(receipt.partyName, ref.billName);
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

          await updateDealPaymentStatus(deal.ID, receipt, isFullyPaid);

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