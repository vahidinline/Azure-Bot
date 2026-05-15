# Azure Xray Telegram Bot & Relay SaaS

This is an automated SaaS system built on Node.js to manage Xray (Vless/WebSocket) connections via Telegram Bot, designed exclusively to run on Azure App Service.

## Features

- 🤖 Telegram Bot UI for Users
- 🔄 In-memory Routing Cache for High-Speed Proxy
- ☁️ Seamless Integration with MHSanaei 3x-ui Panel
- 🎁 Daily 500MB Free Quota with Auto-Reset (Node-Cron)
- 💳 Crypto Payments via NowPayments Webhook

## Deployment on Azure

1. Fork or Clone this repository.
2. Go to **Azure Portal > App Service > Deployment Center**.
3. Select **GitHub** as the source and link your repository.
4. Add the following keys in **Environment Variables**:
   - `BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `XUI_URL`, `XUI_USERNAME`, `XUI_PASSWORD`
