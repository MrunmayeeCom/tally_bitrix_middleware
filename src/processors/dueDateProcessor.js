const { getDealsInPipeline, getStages, updateDeal, sendNotification } = require('../services/bitrixService');
const { getTallyPipelineCategoryId } = require('../services/pipelineService');
const { getEscalationLastSent, setEscalationLastSent } = require('../utils/syncHistory');
const logger = require('../utils/logger');

const ESCALATION_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// ─────────────────────────────────────────
// Due Date Automation Processor
// Runs daily — checks all deals in Tally Outstanding pipeline
// and moves/notifies based on due date
// ─────────────────────────────────────────

async function processDueDates() {
  try {
    logger.info('Due date automation started');

    const categoryId = await getTallyPipelineCategoryId();
    if (!categoryId) {
      logger.warn('No Tally pipeline found — skipping due date check');
      return;
    }

    // Get all stage IDs for this pipeline
    const stages = await getStages(categoryId);
    const stageMap = {};
    stages.forEach(s => {
      stageMap[(s.NAME || s.name).toLowerCase()] = s.STATUS_ID || s.id;
    });

    logger.info('Pipeline stages loaded', { stageMap });

    const overdueStageId  = stageMap['overdue'];
    const followUpStageId = stageMap['follow up'];
    const newBillStageId  = stageMap['new bill'];

    if (!overdueStageId) {
      logger.warn('Overdue stage not found in pipeline — check stage names');
      return;
    }

    // Fetch all deals in the pipeline
    const deals = await getDealsInPipeline(categoryId);
    logger.info(`Checking ${deals.length} deals for due date automation`);

    const today    = new Date();
    today.setHours(0, 0, 0, 0);

    let movedToOverdue  = 0;
    let notified7Days   = 0;
    let escalated       = 0;

    for (const deal of deals) {
      try {
        if (!deal.CLOSEDATE) {
          logger.warn('Deal has no due date — skipping', { dealId: deal.ID, title: deal.TITLE });
          continue;
        }

        const closeDate = new Date(deal.CLOSEDATE);
        closeDate.setHours(0, 0, 0, 0);

        const diffDays = Math.floor((closeDate - today) / (1000 * 60 * 60 * 24));
        const currentStage = deal.STAGE_ID;

        // Already closed/won — skip
        if (currentStage === 'WON' || currentStage === 'LOSE') continue;

        // 1 — Move to Overdue if past due date and not already overdue
        if (diffDays < 0 && currentStage !== overdueStageId) {
          await updateDeal(deal.ID, { STAGE_ID: overdueStageId });
          logger.info('Deal moved to Overdue', {
            dealId: deal.ID,
            title:  deal.TITLE,
            daysOverdue: Math.abs(diffDays)
          });
          movedToOverdue++;
        }

        // 2 — Move to Follow Up and send 7-day reminder
        if (diffDays === 7 && followUpStageId && currentStage === newBillStageId) {
          await updateDeal(deal.ID, { STAGE_ID: followUpStageId });
          logger.info('Deal moved to Follow Up — 7 days to due date', { dealId: deal.ID });
        }

        if (diffDays === 7 && deal.ASSIGNED_BY_ID) {
          await sendNotification(
            deal.ASSIGNED_BY_ID,
            `⚠️ Bill due in 7 days: [b]${deal.TITLE}[/b] | Amount: ₹${deal.OPPORTUNITY} | Due: ${deal.CLOSEDATE}`,
            deal.ID
          );
          logger.info('7-day reminder sent', { dealId: deal.ID, title: deal.TITLE });
          notified7Days++;
        }

        // 2b — Send 1-day reminder notification
        if (diffDays === 1 && deal.ASSIGNED_BY_ID) {
          await sendNotification(
            deal.ASSIGNED_BY_ID,
            `🔔 Bill due TOMORROW: [b]${deal.TITLE}[/b] | Amount: ₹${deal.OPPORTUNITY} | Due: ${deal.CLOSEDATE}`,
            deal.ID
          );
          logger.info('1-day reminder sent', { dealId: deal.ID, title: deal.TITLE });
          notified7Days++;
        }

        // 3 — Escalation: 30+ days overdue, notify once every 3 days (persisted across restarts)
        if (diffDays < -30 && deal.ASSIGNED_BY_ID) {
          const lastEscalated = getEscalationLastSent(deal.ID);
          const now = Date.now();
          if (now - lastEscalated >= ESCALATION_COOLDOWN_MS) {
            await sendNotification(
              deal.ASSIGNED_BY_ID,
              `🚨 OVERDUE 30+ DAYS: [b]${deal.TITLE}[/b] | Amount: ₹${deal.OPPORTUNITY} | Was due: ${deal.CLOSEDATE}`,
              deal.ID
            );
            setEscalationLastSent(deal.ID, now);
            logger.info('30-day escalation sent', { dealId: deal.ID, title: deal.TITLE });
            escalated++;
          } else {
            const hoursLeft = Math.round((ESCALATION_COOLDOWN_MS - (now - lastEscalated)) / 3600000);
            logger.info('30-day escalation skipped — cooldown active', { dealId: deal.ID, hoursLeft });
          }
        }


      } catch (dealError) {
        logger.error('Failed to process due date for deal', {
          dealId:  deal.ID,
          message: dealError.message
        });
      }
    }

    logger.info('Due date automation completed', {
      movedToOverdue,
      notified7Days,
      escalated
    });

  } catch (error) {
    logger.error('Due date processor failed', { message: error.message });
    throw error;
  }
}

module.exports = { processDueDates };