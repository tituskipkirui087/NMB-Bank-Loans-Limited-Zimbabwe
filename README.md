# NMB Bank Loans

## Running Locally

The login flow requires a local Node.js server to handle Telegram callbacks.

### Setup

1. Copy `.env.example` to `.env` and fill in the values:
```bash
copy .env.example .env
```

2. Start the local server:
```bash
node scripts/server.js
```

3. Open `http://localhost:3000/login.html` in your browser

### How the Login Flow Works

1. User enters mobile number and PIN
2. Frontend POSTs to `/api/notify/login` - creates a record with `decided: false`
3. Telegram bot sends message to admin with "Correct"/"Wrong" buttons
4. Local server polls Telegram via `getUpdates` (every 1 second)
5. Admin clicks "Correct" - callback received by server
6. Server updates record to `decided: true, status: 'approved'`
7. Frontend polls `/api/login/status/:id` - sees `decided: true`
8. OTP form appears

### Important

- The local server MUST be running for the login flow to work
- Clear any existing Telegram webhook before running: visit `http://localhost:3000/api/setup/purge-webhook`
- Check server status: visit `http://localhost:3000/api/health`