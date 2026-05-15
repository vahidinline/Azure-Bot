global.WebSocket = require('ws');
const express = require('express');
const http = require('http');
const httpProxy = require('http-proxy');
const axios = require('axios');
const crypto = require('crypto');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

require('dotenv').config();

const PORT = process.env.PORT || process.env.WEBSITES_PORT || 8080;
const AZURE_DOMAIN = process.env.WEBSITE_HOSTNAME || 'localhost';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);
const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());

const XUI_URL = (process.env.XUI_URL || '').replace(/\/$/, '');
const XUI_INBOUND_ID = parseInt(process.env.XUI_INBOUND_ID || 5);
const TARGET_SERVER = process.env.DEFAULT_TARGET_SERVER || 'cdn.kidy.care:443';
const TARGET_PATH = process.env.DEFAULT_TARGET_PATH || '/azure-relay/';

// ==========================================
// 1. توابع API سنایی (بدون تغییر)
// ==========================================
const xuiClient = axios.create({
  timeout: 10000,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  headers: { 'User-Agent': 'Azure-Bot' },
});

async function xuiLogin() {
  const payload = new URLSearchParams({
    username: process.env.XUI_USERNAME,
    password: process.env.XUI_PASSWORD,
  });
  try {
    const res = await xuiClient.post(`${XUI_URL}/login`, payload, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      maxRedirects: 0,
    });
    return res.headers['set-cookie'][0].split(';')[0];
  } catch (e) {
    if (e.response && e.response.status === 302)
      return e.response.headers['set-cookie'][0].split(';')[0];
    throw new Error('Login Fail');
  }
}

async function createSanaeiClient(uuid, tgId, gbLimit) {
  const cookie = await xuiLogin();
  const limitBytes = gbLimit > 0 ? Math.floor(gbLimit * 1024 * 1024 * 1024) : 0;
  const clientSettings = {
    id: uuid,
    flow: '',
    email: `tg_${tgId}`,
    limitIp: 2,
    totalGB: limitBytes,
    expiryTime: 0,
    enable: true,
    tgId: tgId.toString(),
    subId: uuidv4(),
  };
  await xuiClient.post(
    `${XUI_URL}/panel/api/inbounds/addClient`,
    {
      id: XUI_INBOUND_ID,
      settings: JSON.stringify({ clients: [clientSettings] }),
    },
    { headers: { Cookie: cookie, 'Content-Type': 'application/json' } },
  );
}

// ==========================================
// 2. سیستم کش (Cache)
// ==========================================
let routingCache = {};
async function updateRoutingCache() {
  try {
    const { data } = await supabase
      .from('telegram_users')
      .select('relay_token');
    if (data) {
      const newCache = {};
      const cleanTarget = TARGET_SERVER.replace(':443', '').replace(':80', '');
      const finalUrl = TARGET_SERVER.includes(':443')
        ? `https://${cleanTarget}`
        : `http://${cleanTarget}`;
      data.forEach((u) => {
        newCache[`/${u.relay_token}`] = {
          url: finalUrl,
          realPath: TARGET_PATH,
          customHost: cleanTarget,
        };
      });
      routingCache = newCache;
      console.log(`✅ Cache Updated. Users: ${data.length}`);
    }
  } catch (e) {
    console.error('Cache Err');
  }
}
updateRoutingCache();
setInterval(updateRoutingCache, 60000);

// ==========================================
// 3. ربات تلگرام (بدون تغییر)
// ==========================================
bot.start(async (ctx) => {
  const tgId = ctx.from.id;
  let { data: user } = await supabase
    .from('telegram_users')
    .select('*')
    .eq('tg_id', tgId)
    .single();
  if (!user) {
    try {
      const uuid = uuidv4();
      const relayToken = `usr-${Math.random().toString(36).substr(2, 8)}`;
      await createSanaeiClient(uuid, tgId, 0.5);
      await supabase
        .from('telegram_users')
        .insert([{ tg_id: tgId, uuid, relay_token: relayToken }]);
      user = { uuid, relay_token: relayToken };
      updateRoutingCache();
    } catch (err) {
      return ctx.reply('خطا در سرور');
    }
  }
  const config = `vless://${user.uuid}@${AZURE_DOMAIN}:443?type=ws&security=tls&path=/${user.relay_token}&host=${AZURE_DOMAIN}&sni=${AZURE_DOMAIN}#AzureBot-${tgId}`;
  ctx.reply(`✅ کانفیگ VLESS شما:\n\n<code>${config}</code>`, {
    parse_mode: 'HTML',
  });
});

// ==========================================
// 4. رله ترافیک Xray (بهینه‌سازی شده برای آژور)
// ==========================================
const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  secure: false,
  ws: true,
  xfwd: true,
});

// مدیریت خطاهای پروکسی
proxy.on('error', (err, req, res) => {
  console.log(`❌ [PROXY ERROR]: ${err.message}`);
});

function extractToken(url) {
  if (!url) return '/';
  const parts = url.split('?')[0].replace(/\/+/g, '/').split('/');
  return parts.length > 1 ? `/${parts[1]}` : '/';
}

// رله وب‌سایت و API
app.use((req, res, next) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/telegraf'))
    return next();
  const token = extractToken(req.url);
  const targetData = routingCache[token];

  if (targetData) {
    req.url = req.url.replace(token, targetData.realPath).replace(/\/\//g, '/');
    req.headers['host'] = targetData.customHost;
    proxy.web(req, res, { target: targetData.url });
  } else {
    res.status(200).send('Azure SaaS Active');
  }
});

const server = http.createServer(app);

// مدیریت وب‌سوکت Xray
server.on('upgrade', (req, socket, head) => {
  const token = extractToken(req.url);
  const targetData = routingCache[token];

  if (targetData) {
    // لاگ برای دیباگ
    console.log(`🔌 [WS] Routing token ${token} to ${targetData.url}`);

    // بازنویسی مسیر
    const newUrl = req.url
      .replace(token, targetData.realPath)
      .replace(/\/\//g, '/');
    req.url = newUrl;

    // تنظیم هدرهای حیاتی برای آژور
    req.headers['host'] = targetData.customHost;
    req.headers['connection'] = 'upgrade';
    req.headers['upgrade'] = 'websocket';

    proxy.ws(req, socket, head, {
      target: targetData.url,
      headers: { host: targetData.customHost },
    });
  } else {
    console.log(`🚫 [WS] Invalid token: ${token}`);
    socket.destroy();
  }
});

// ==========================================
// 5. اجرای نهایی
// ==========================================
const SECRET_PATH = `/telegraf/${bot.secretPathComponent()}`;
app.use(bot.webhookCallback(SECRET_PATH));

server.listen(PORT, async () => {
  console.log(`🚀 Azure Xray Bot-Relay Running on Port ${PORT}`);
  if (process.env.WEBSITE_HOSTNAME) {
    await bot.telegram.setWebhook(
      `https://${process.env.WEBSITE_HOSTNAME}${SECRET_PATH}`,
    );
  }
});
