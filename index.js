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

require('dotenv').config();

// 1. تنظیمات
const PORT = process.env.PORT || 8080;
const AZURE_DOMAIN = process.env.WEBSITE_HOSTNAME || 'localhost';
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);
const bot = new Telegraf(process.env.BOT_TOKEN);

const XUI_URL = (process.env.XUI_URL || '').replace(/\/$/, '');
const XUI_INBOUND_ID = parseInt(process.env.XUI_INBOUND_ID || 5);
const TARGET_SERVER = process.env.DEFAULT_TARGET_SERVER || 'cdn.kidy.care:443';
const TARGET_PATH = process.env.DEFAULT_TARGET_PATH || '/azure-relay/';
const REQUIRED_CHANNELS = (process.env.REQUIRED_CHANNELS || '')
  .split(',')
  .filter((c) => c.trim());

// 2. توابع سنایی
const xuiClient = axios.create({
  timeout: 10000,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
});

async function xuiLogin() {
  const payload = new URLSearchParams({
    username: process.env.XUI_USERNAME,
    password: process.env.XUI_PASSWORD,
  });
  try {
    const res = await xuiClient.post(`${XUI_URL}/login`, payload, {
      maxRedirects: 0,
    });
    return res.headers['set-cookie'][0].split(';')[0];
  } catch (e) {
    if (e.response && e.response.status === 302)
      return e.response.headers['set-cookie'][0].split(';')[0];
    throw new Error('XUI Login Failed');
  }
}

async function createSanaeiClient(uuid, tgId, gbLimit) {
  const cookie = await xuiLogin();
  const limitBytes = gbLimit > 0 ? Math.floor(gbLimit * 1024 * 1024 * 1024) : 0;
  const settings = JSON.stringify({
    clients: [
      {
        id: uuid,
        flow: '',
        email: `tg_${tgId}`,
        limitIp: 2,
        totalGB: limitBytes,
        expiryTime: 0,
        enable: true,
        tgId: tgId.toString(),
        subId: crypto.randomUUID(),
      },
    ],
  });
  await xuiClient.post(
    `${XUI_URL}/panel/api/inbounds/addClient`,
    { id: XUI_INBOUND_ID, settings },
    { headers: { Cookie: cookie } },
  );
}

async function getSanaeiUsage(email) {
  try {
    const cookie = await xuiLogin();
    const res = await xuiClient.get(
      `${XUI_URL}/panel/api/inbounds/getClientTraffics/${email}`,
      { headers: { Cookie: cookie } },
    );
    if (res.data.success && res.data.obj) {
      return ((res.data.obj.up + res.data.obj.down) / 1024 ** 3).toFixed(3);
    }
    return 0;
  } catch (e) {
    return 0;
  }
}

// 3. سیستم کش مسیرها
let routingCache = {};
async function updateRoutingCache() {
  try {
    const { data } = await supabase
      .from('telegram_users')
      .select('relay_token');
    if (data) {
      const newCache = {};
      const finalUrl = `https://${TARGET_SERVER}`;
      data.forEach((u) => {
        newCache[`/${u.relay_token}`] = finalUrl;
      });
      routingCache = newCache;
      console.log(`✅ Cache Updated: ${data.length} users`);
    }
  } catch (e) {
    console.error('Cache Error');
  }
}
updateRoutingCache();
setInterval(updateRoutingCache, 60000);

// 4. منطق ربات تلگرام
const mainMenu = Markup.inlineKeyboard([
  [Markup.button.callback('🚀 دریافت کانفیگ', 'get_config')],
  [Markup.button.callback('📊 استعلام مصرف', 'check_usage')],
]);

bot.start(async (ctx) => {
  ctx.reply(
    `سلام ${ctx.from.first_name}! برای دریافت سرویس از دکمه زیر استفاده کنید.`,
    mainMenu,
  );
});

bot.action('get_config', async (ctx) => {
  const tgId = ctx.from.id;
  let { data: user } = await supabase
    .from('telegram_users')
    .select('*')
    .eq('tg_id', tgId)
    .single();

  if (!user) {
    try {
      const uuid = uuidv4();
      const token = `usr-${Math.random().toString(36).substr(2, 8)}`;
      await createSanaeiClient(uuid, tgId, 0.5);
      const { data } = await supabase
        .from('telegram_users')
        .insert([{ tg_id: tgId, uuid, relay_token: token }])
        .select()
        .single();
      user = data;
      await updateRoutingCache();
    } catch (e) {
      return ctx.reply('خطا در ساخت کانفیگ در سنایی.');
    }
  }

  // هدر host در کانفیگ نهایی برابر با آژور است (درست)
  const vless = `vless://${user.uuid}@${AZURE_DOMAIN}:443?type=ws&security=tls&path=/${user.relay_token}&host=${AZURE_DOMAIN}&sni=${AZURE_DOMAIN}#Azure-${tgId}`;
  ctx.reply(`✅ کانفیگ اختصاصی شما:\n\n<code>${vless}</code>`, {
    parse_mode: 'HTML',
    ...mainMenu,
  });
});

bot.action('check_usage', async (ctx) => {
  const usage = await getSanaeiUsage(`tg_${ctx.from.id}`);
  ctx.reply(`📊 مصرف شما: ${usage} GB از 0.500 GB`, mainMenu);
});

// 5. رله پروکسی (منطق خام و فوق‌ساده)
const app = express();
const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  ws: true,
  secure: false,
});

// استخراج توکن به روش رله‌های ساده
function getReqToken(url) {
  if (!url) return '';
  return '/' + url.split('/')[1].split('?')[0];
}

app.use((req, res, next) => {
  if (req.url.startsWith('/telegraf') || req.url.startsWith('/api'))
    return next();

  const token = getReqToken(req.url);
  const target = routingCache[token];

  if (target) {
    // بازنویسی مسیر: جایگزینی توکن با مسیر اصلی سنایی
    req.url = req.url.replace(token, TARGET_PATH).replace(/\/\//g, '/');
    proxy.web(req, res, { target });
  } else {
    res.status(200).send('Azure SaaS Relay is Running');
  }
});

const server = http.createServer(app);

// هندل کردن ارتقای وب‌سوکت (Upgrade)
server.on('upgrade', (req, socket, head) => {
  const token = getReqToken(req.url);
  const target = routingCache[token];

  if (target) {
    req.url = req.url.replace(token, TARGET_PATH).replace(/\/\//g, '/');
    // استفاده از changeOrigin: true برای مدیریت خودکار هدر Host داخلی
    proxy.ws(req, socket, head, { target });
  } else {
    socket.destroy();
  }
});

const SECRET_PATH = `/telegraf/${bot.secretPathComponent()}`;
app.use(bot.webhookCallback(SECRET_PATH));

server.listen(PORT, async () => {
  console.log(`🚀 Relay running on ${PORT}`);
  if (AZURE_DOMAIN !== 'localhost') {
    await bot.telegram.setWebhook(`https://${AZURE_DOMAIN}${SECRET_PATH}`);
  }
});
