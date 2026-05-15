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
// 1. توابع ارتباط با سنایی
// ==========================================
const xuiClient = axios.create({
  timeout: 12000,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  headers: { 'User-Agent': 'Azure-SaaS-Bot' },
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
    const cookies = res.headers['set-cookie'];
    if (!cookies) throw new Error('No cookie');
    return cookies[0].split(';')[0];
  } catch (error) {
    if (
      error.response &&
      (error.response.status === 302 || error.response.status === 303)
    ) {
      return error.response.headers['set-cookie'][0].split(';')[0];
    }
    throw new Error('لاگین سنایی با شکست مواجه شد');
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
  const res = await xuiClient.post(
    `${XUI_URL}/panel/api/inbounds/addClient`,
    {
      id: XUI_INBOUND_ID,
      settings: JSON.stringify({ clients: [clientSettings] }),
    },
    { headers: { Cookie: cookie, 'Content-Type': 'application/json' } },
  );
  if (!res.data.success) throw new Error(res.data.msg);
}

async function updateSanaeiClientLimit(uuid, tgId, gbLimit) {
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
    `${XUI_URL}/panel/api/inbounds/updateClient/${uuid}`,
    {
      id: XUI_INBOUND_ID,
      settings: JSON.stringify({ clients: [clientSettings] }),
    },
    { headers: { Cookie: cookie, 'Content-Type': 'application/json' } },
  );
}

async function getSanaeiUsage(email) {
  const cookie = await xuiLogin();
  const res = await xuiClient.get(
    `${XUI_URL}/panel/api/inbounds/getClientTraffics/${email}`,
    { headers: { Cookie: cookie } },
  );
  if (res.data.success && res.data.obj) {
    const total = (res.data.obj.up || 0) + (res.data.obj.down || 0);
    return (total / (1024 * 1024 * 1024)).toFixed(2);
  }
  return 0;
}

async function resetSanaeiTraffic(email) {
  const cookie = await xuiLogin();
  await xuiClient.post(
    `${XUI_URL}/panel/api/inbounds/resetClientTraffic/${email}`,
    {},
    { headers: { Cookie: cookie } },
  );
}

// ==========================================
// 2. سیستم کش مسیرها (با آپدیت فوری)
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
      const finalUrl =
        TARGET_SERVER.includes(':443') || TARGET_SERVER.includes('https')
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
      console.log(
        `✅ Cache Updated. Active: ${Object.keys(routingCache).length}`,
      );
    }
  } catch (e) {
    console.error('Cache Error:', e.message);
  }
}

updateRoutingCache();
setInterval(updateRoutingCache, 60000);

// ==========================================
// 3. ربات تلگرام
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
      user = { uuid, relay_token: relayToken, is_premium: false };
      await updateRoutingCache(); // 🔴 آپدیت فوری کش برای کاربر جدید
    } catch (err) {
      return ctx.reply(
        `❌ خطا در اتصال به سرور مرکزی.\nدلیل فنی: ${err.message}`,
      );
    }
  }

  const config = `vless://${user.uuid}@${AZURE_DOMAIN}:443?type=ws&security=tls&path=/${user.relay_token}&host=${AZURE_DOMAIN}&sni=${AZURE_DOMAIN}#FreeSaaS-${tgId}`;

  ctx.reply(
    `✅ <b>کانفیگ VLESS شما آماده است:</b>\n\n<code>${config}</code>\n\n📌 <b>قوانین:</b>\n۵۰۰ مگابایت روزانه.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📊 استعلام حجم', 'check_status')],
        [Markup.button.callback('💎 ارتقا به نامحدود (VIP)', 'buy_vip')],
      ]),
    },
  );
});

bot.action('check_status', async (ctx) => {
  try {
    const usage = await getSanaeiUsage(`tg_${ctx.from.id}`);
    const { data: user } = await supabase
      .from('telegram_users')
      .select('is_premium')
      .eq('tg_id', ctx.from.id)
      .single();
    ctx.reply(
      `📊 مصرف شما: ${usage} GB\nسقف: ${user?.is_premium ? 'VIP' : '0.5GB'}`,
    );
  } catch (e) {
    ctx.answerCbQuery('خطا');
  }
});

bot.action('buy_vip', async (ctx) => {
  try {
    const response = await axios.post(
      'https://api.nowpayments.io/v1/invoice',
      {
        price_amount: 5,
        price_currency: 'usd',
        pay_currency: 'trx',
        order_id: ctx.from.id.toString(),
        ipn_callback_url: `https://${AZURE_DOMAIN}/api/webhook`,
        success_url: `https://t.me/${ctx.botInfo.username}`,
      },
      { headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY } },
    );
    ctx.reply(
      'لینک پرداخت شما:',
      Markup.inlineKeyboard([
        [Markup.button.url('💳 پرداخت آنلاین', response.data.invoice_url)],
      ]),
    );
  } catch (e) {
    ctx.answerCbQuery('خطای درگاه');
  }
});

// ==========================================
// 4. وب‌هوک پرداخت و رله ترافیک
// ==========================================
app.post('/api/webhook', async (req, res) => {
  // منطق تایید پرداخت (مشابه قبل)
  res.status(200).send('OK');
});

const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  secure: false,
  ws: true,
  xfwd: true,
});

function extractToken(url) {
  if (!url) return '/';
  const parts = url.split('?')[0].replace(/\/+/g, '/').split('/');
  return parts.length > 1 ? `/${parts[1]}` : '/';
}

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
    res.status(404).send('Relay active');
  }
});

const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  const token = extractToken(req.url);
  const targetData = routingCache[token];
  if (targetData) {
    req.url = req.url.replace(token, targetData.realPath).replace(/\/\//g, '/');
    req.headers['host'] = targetData.customHost;
    // 🔴 تنظیمات حیاتی برای عبور از TLS سنایی
    proxy.ws(req, socket, head, { target: targetData.url });
  } else {
    socket.destroy();
  }
});

const SECRET_PATH = `/telegraf/${bot.secretPathComponent()}`;
app.use(bot.webhookCallback(SECRET_PATH));

cron.schedule('0 0 * * *', async () => {
  const { data: freeUsers } = await supabase
    .from('telegram_users')
    .select('tg_id')
    .eq('is_premium', false);
  if (freeUsers)
    for (let u of freeUsers)
      resetSanaeiTraffic(`tg_${u.tg_id}`).catch(() => {});
});

server.listen(PORT, async () => {
  console.log(`🚀 Running on ${PORT}`);
  if (process.env.WEBSITE_HOSTNAME) {
    await bot.telegram.setWebhook(
      `https://${process.env.WEBSITE_HOSTNAME}${SECRET_PATH}`,
    );
  }
});
