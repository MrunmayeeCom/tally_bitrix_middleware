const { callBitrix } = require('../connectors/bitrixConnector');
const logger = require('../utils/logger');

const PIPELINE_NAME  = 'Tally Outstanding data';
const PIPELINE_STAGES = [
  { NAME: 'New Bill'         },
  { NAME: 'Follow Up'        },
  { NAME: 'Overdue'          },
  { NAME: 'Payment Received' },
  { NAME: 'Closed'           },
  { NAME: 'Deal Won'         }

];

let tallyPipelineCategoryId = null;

async function getTallyPipelineCategoryId() {
  if (tallyPipelineCategoryId) return tallyPipelineCategoryId;
  try {
    const fs   = require('fs');
    const path = require('path');
    const cache = path.join(__dirname, '../../logs/pipeline-cache.json');
    if (fs.existsSync(cache)) {
      const data = JSON.parse(fs.readFileSync(cache, 'utf8'));
      if (data.categoryId) { tallyPipelineCategoryId = data.categoryId; return tallyPipelineCategoryId; }
    }
  } catch {}
  return tallyPipelineCategoryId;
}

async function setupPipeline() {
  try {
    logger.info('Checking Tally Outstanding pipeline in Bitrix24...');

    const data = await callBitrix('crm.category.list', { entityTypeId: 2 });
    const allCategories = data.result?.categories || data.result || [];
    logger.info(`Found ${allCategories.length} existing pipelines`);

    const existing = allCategories.find(c => 
      (c.name || c.NAME || '').toLowerCase() === PIPELINE_NAME.toLowerCase()
    );

    if (existing) {
      tallyPipelineCategoryId = existing.id || existing.ID;
      logger.info('Tally Outstanding pipeline already exists', { categoryId: tallyPipelineCategoryId });
      try {
        const fs   = require('fs');
        const path = require('path');
        const cache = path.join(__dirname, '../../logs/pipeline-cache.json');
        fs.writeFileSync(cache, JSON.stringify({ categoryId: tallyPipelineCategoryId }));
      } catch {}
      return tallyPipelineCategoryId;
    }

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
    try {
      const fs   = require('fs');
      const path = require('path');
      const cache = path.join(__dirname, '../../logs/pipeline-cache.json');
      fs.writeFileSync(cache, JSON.stringify({ categoryId }));
    } catch {}
    await setupDealCustomFields();
    return categoryId;

  } catch (error) {
    logger.error('Pipeline setup failed', { message: error.message });
  }
}

async function setupDealCustomFields() {
  const fields = [
    { FIELD_NAME: 'UF_BILL_DATE',       USER_TYPE_ID: 'date',    LIST_COLUMN_LABEL: 'Bill Date'       },
    { FIELD_NAME: 'UF_DUE_DATE',      USER_TYPE_ID: 'date',    LIST_COLUMN_LABEL: 'Due Date'        },
    { FIELD_NAME: 'UF_BILL_AMOUNT',   USER_TYPE_ID: 'double',  LIST_COLUMN_LABEL: 'Bill Amount'     },
    { FIELD_NAME: 'UF_OUTSTANDING',    USER_TYPE_ID: 'double',  LIST_COLUMN_LABEL: 'Outstanding'     },
    { FIELD_NAME: 'UF_DAYS_PENDING',  USER_TYPE_ID: 'integer', LIST_COLUMN_LABEL: 'Days Pending'    },
    { FIELD_NAME: 'UF_INVOICE_NUMBER',USER_TYPE_ID: 'string',  LIST_COLUMN_LABEL: 'Invoice Number'  },
    { FIELD_NAME: 'UF_INVOICE_DATE',  USER_TYPE_ID: 'date',    LIST_COLUMN_LABEL: 'Invoice Date'    },
    { FIELD_NAME: 'UF_PAYMENT_STATUS',USER_TYPE_ID:'string',  LIST_COLUMN_LABEL: 'Payment Status'  },
    { FIELD_NAME: 'UF_PAYMENT_DATE',  USER_TYPE_ID: 'date',    LIST_COLUMN_LABEL: 'Payment Date'    },
    { FIELD_NAME: 'UF_PAYMENT_AMOUNT',USER_TYPE_ID: 'double',  LIST_COLUMN_LABEL: 'Payment Amount'  },
    { FIELD_NAME: 'UF_RECEIPT_NUMBER',USER_TYPE_ID: 'string',  LIST_COLUMN_LABEL: 'Receipt Number'  },
    { FIELD_NAME: 'UF_CLOSING_STOCK', USER_TYPE_ID: 'string',  LIST_COLUMN_LABEL: 'Closing Stock'   },
  ];

  for (const field of fields) {
    try {
      await callBitrix('crm.deal.userfield.add', {
        fields: {
          ...field,
          ENTITY_ID:   'CRM_DEAL',
          EDIT_FORM_LABEL: field.LIST_COLUMN_LABEL,
          MANDATORY:   'N',
          SHOW_IN_LIST: 'Y',
        }
      });
      logger.info('Custom deal field created', { fieldName: field.FIELD_NAME });
    } catch (e) {
      logger.info('Custom deal field already exists or skipped', { fieldName: field.FIELD_NAME, message: e.message });
    }
  }
}

function findStage(stageName) {
  if (!tallyPipelineCategoryId) return null;
  const stages = PIPELINE_STAGES;
  const match = stages.find(s => s.NAME.toLowerCase() === stageName.toLowerCase());
  if (!match) return null;
  return `${tallyPipelineCategoryId}_${stages.indexOf(match)}`;
}

module.exports = { setupPipeline, getTallyPipelineCategoryId, findStage };