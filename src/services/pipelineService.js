const { callBitrix } = require('../connectors/bitrixConnector');
const logger = require('../utils/logger');

const PIPELINE_NAME  = 'Tally Outstanding test';
const PIPELINE_STAGES = [
  { NAME: 'New Bill'         },
  { NAME: 'Follow Up'        },
  { NAME: 'Overdue'          },
  { NAME: 'Payment Received' },
  { NAME: 'Closed'           }
];

// In-memory store — survives for lifetime of the process
let tallyPipelineCategoryId = null;

async function getTallyPipelineCategoryId() {
  return tallyPipelineCategoryId;
}

async function setupPipeline() {
  try {
    logger.info('Checking Tally Outstanding pipeline in Bitrix24...');

    // Step 1: Check if pipeline already exists (fetch all, not just first page)
    // crm.category.list returns ALL categories in one call (ignores pagination)
    const data = await callBitrix('crm.category.list', { entityTypeId: 2 });
    const allCategories = data.result?.categories || data.result || [];
    logger.info(`Found ${allCategories.length} existing pipelines`);

    const existing = allCategories.find(c => 
      (c.name || c.NAME || '').toLowerCase() === PIPELINE_NAME.toLowerCase()
    );

    if (existing) {
      tallyPipelineCategoryId = existing.id || existing.ID;
      logger.info('Tally Outstanding pipeline already exists', { categoryId: tallyPipelineCategoryId });
      return tallyPipelineCategoryId;
    }

    // Step 2: Create pipeline
    logger.info('Creating Tally Outstanding pipeline...');
    const created = await callBitrix('crm.category.add', {
      entityTypeId: 2,
      fields: {
        name:       PIPELINE_NAME,
        isDefault:  'N',
        sort:       100
      }
    });

    const categoryId = created.result?.category?.id 
      || created.result?.id 
      || created.result?.category 
      || created.result;
    tallyPipelineCategoryId = categoryId;
    logger.info('Pipeline created', { categoryId });

    // Step 3: Fetch auto-created stages and rename them to our custom names
    const entityId = `DEAL_STAGE_${categoryId}`;

    const statusData = await callBitrix('crm.status.list', {
      filter: { ENTITY_ID: entityId }
    });
    const existingStages = statusData.result || [];
    logger.info(`Found ${existingStages.length} default stages to rename`);

    for (let i = 0; i < PIPELINE_STAGES.length; i++) {
      if (existingStages[i]) {
        await callBitrix('crm.status.update', {
          id: existingStages[i].ID,
          fields: { NAME: PIPELINE_STAGES[i].NAME }
        });
        logger.info('Stage renamed', {
          from: existingStages[i].NAME,
          to:   PIPELINE_STAGES[i].NAME
        });
      }
    }

    logger.info('Tally Outstanding pipeline setup complete', { categoryId });
    return categoryId;

  } catch (error) {
    logger.error('Pipeline setup failed', { message: error.message });
    // Non-fatal — server still starts, deals go to default pipeline
  }
}

module.exports = { setupPipeline, getTallyPipelineCategoryId };