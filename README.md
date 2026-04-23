# Tally Bitrix24 Middleware

Node.js middleware that syncs data between Bitrix24 CRM and TallyPrime ERP.

## Tech Stack
- Node.js + Express.js
- Axios
- node-cron
- dotenv

## Setup

1. Clone the repo
2. Run `npm install`
3. Copy `.env.example` to `.env` and fill values
4. Run `npm run dev`

## Environment Variables
```
PORT=5050
NODE_ENV=development
BITRIX_WEBHOOK_URL=https://your-domain.bitrix24.com/rest/USER_ID/TOKEN
TALLY_HOST=localhost
TALLY_PORT=9000
TALLY_COMPANY=Your Company Name
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Server health check |
| POST | /webhook | Receives Bitrix24 events |

## Webhook Events Handled

| Event | Action |
|-------|--------|
| ONCRMCONTACTADD | Creates ledger in Tally |
| ONCRMCONTACTUPDATE | Updates ledger in Tally |
| ONCRMCOMPANYADD | Creates ledger in Tally |
| ONCRMCOMPANYUPDATE | Updates ledger in Tally |
| ONCRMINVOICEADD | Creates voucher in Tally |
| ONCRMINVOICEUPDATE | Updates voucher in Tally |
| ONCRMQUOTEADD | Creates sales order in Tally |
| ONCRMQUOTEUPDATE | Updates sales order in Tally |

## Scheduled Jobs

| Time | Job |
|------|-----|
| 9:00 AM IST | Outstanding bills sync |
| 11:00 PM IST | Outstanding bills sync |

## Sync Flow
```
Bitrix24 Contact/Company
        ↓
   Middleware
        ↓
   Tally Ledger

Tally Outstanding Bills
        ↓
   Middleware (scheduler)
        ↓
   Bitrix24 Deals
```