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

// 1. تنظیمات اولیه
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
  httpsAgent: new https.Agent({ rejectUnauthorized: false }), // رفع خطای SSL سنایی
  headers: { 'User-Agent': 'Mozilla/5.0' },
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
    if (
      e.response &&
      (e.response.status === 302 || e.response.status === 303)
    ) {
      return e.response.headers['set-cookie'][0].split(';')[0];
    }
    throw new Error('لاگین سنایی ناموفق');
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

async function getSanaeiUsage(email) {
  const cookie = await xuiLogin();
  const res = await xuiClient.get(
    `${XUI_URL}/panel/api/inbounds/getClientTraffics/${email}`,
    { headers: { Cookie: cookie } },
  );
  if (res.data.success && res.data.obj) {
    const total = (res.data.obj.up || 0) + (res.data.obj.down || 0);
    return (total / (1024 * 1024 * 1024)).toFixed(3);
  }
  return 0;
}

// 3. سیستم کش رله
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
      console.log(
        `✅ [CACHE] Updated: ${Object.keys(routingCache).length} Active Users`,
      );
    }
  } catch (e) {
    console.error('❌ Cache update failed');
  }
}
updateRoutingCache();
setInterval(updateRoutingCache, 60000);

// 4. ربات تلگرام
async function checkJoin(ctx) {
  if (REQUIRED_CHANNELS.length === 0) return true;
  for (const channel of REQUIRED_CHANNELS) {
    try {
      const member = await bot.telegram.getChatMember(
        channel.trim(),
        ctx.from.id,
      );
      if (['left', 'kicked'].includes(member.status)) return false;
    } catch (e) {
      return false;
    }
  }
  return true;
}

const mainMenu = Markup.inlineKeyboard([
  [Markup.button.callback('🚀 دریافت / مشاهده کانفیگ', 'get_config')],
  [Markup.button.callback('📊 استعلام مصرف', 'check_usage')],
  [Markup.button.callback('💎 خرید VIP (نامحدود)', 'buy_vip')],
]);

bot.start(async (ctx) => {
  const isJoined = await checkJoin(ctx);
  if (!isJoined) {
    return ctx.reply(
      `👋 سلام!\nبرای استفاده از ربات باید در کانال عضو باشید:`,
      Markup.inlineKeyboard([
        ...REQUIRED_CHANNELS.map((c) => [
          Markup.button.url(
            `📢 عضویت در کانال`,
            `https://t.me/${c.replace('@', '')}`,
          ),
        ]),
        [Markup.button.callback('✅ عضو شدم (تایید)', 'get_config')],
      ]),
    );
  }
  ctx.reply(
    `خوش آمدید! برای دریافت سرویس از دکمه‌های زیر استفاده کنید.`,
    mainMenu,
  );
});

bot.action('get_config', async (ctx) => {
  if (!(await checkJoin(ctx)))
    return ctx.answerCbQuery('❌ ابتدا عضو کانال شوید', { show_alert: true });
  await ctx.answerCbQuery('⌛️ در حال دریافت...');

  let { data: user } = await supabase
    .from('telegram_users')
    .select('*')
    .eq('tg_id', ctx.from.id)
    .single();

  if (!user) {
    try {
      const uuid = uuidv4();
      const relayToken = `usr-${Math.random().toString(36).substr(2, 8)}`;
      await createSanaeiClient(uuid, ctx.from.id, 0.5);
      const { data } = await supabase
        .from('telegram_users')
        .insert([{ tg_id: ctx.from.id, uuid, relay_token: relayToken }])
        .select()
        .single();
      user = data;
      await updateRoutingCache();
    } catch (e) {
      return ctx.reply(`❌ خطا: ${e.message}`);
    }
  }

  const vless = `vless://${user.uuid}@${AZURE_DOMAIN}:443?type=ws&security=tls&path=/${user.relay_token}&host=${AZURE_DOMAIN}&sni=${AZURE_DOMAIN}#Azure-${ctx.from.id}`;
  ctx.reply(
    `✅ <b>سرویس شما فعال است</b>\n\nکانفیگ شما:\n\n<code>${vless}</code>\n\n📌 سقف مصرف: ۵۰۰ مگابایت روزانه`,
    { parse_mode: 'HTML', ...mainMenu },
  );
});

bot.action('check_usage', async (ctx) => {
  try {
    const usage = await getSanaeiUsage(`tg_${ctx.from.id}`);
    const { data } = await supabase
      .from('telegram_users')
      .select('is_premium')
      .eq('tg_id', ctx.from.id)
      .single();
    ctx.reply(
      `📊 گزارش مصرف:\n🔹 مصرف شده: ${usage} GB\n🔋 وضعیت: ${data?.is_premium ? 'VIP' : 'رایگان (0.5GB)'}`,
      mainMenu,
    );
  } catch (e) {
    ctx.answerCbQuery('خطا در استعلام');
  }
});

// 5. پروکسی و رله (حل مشکل فقط آپلود)
const app = express();
app.use(express.json());
const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  secure: false,
  ws: true,
  xfwd: true,
});

// جلوگیری از بافر شدن ترافیک در آژور
proxy.on('proxyRes', (pRes) => {
  pRes.headers['X-Accel-Buffering'] = 'no';
});

app.use((req, res, next) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/telegraf'))
    return next();
  const token = `/${req.url.split('?')[0].replace(/\/+/g, '/').split('/')[1]}`;
  const targetData = routingCache[token];

  if (targetData) {
    req.url = req.url.replace(token, targetData.realPath).replace(/\/\//g, '/');
    req.headers['host'] = targetData.customHost;
    delete req.headers['origin'];
    delete req.headers['referer'];
    proxy.web(req, res, { target: targetData.url });
  } else {
    res.status(200).send('Azure SaaS Active');
  }
});

const server = http.createServer(app);

// 🔴 قلب تپنده: مدیریت وب‌سوکت اصلاح شده برای آژور
server.on('upgrade', (req, socket, head) => {
  const token = `/${req.url.split('?')[0].replace(/\/+/g, '/').split('/')[1]}`;
  const targetData = routingCache[token];

  if (targetData) {
    console.log(`🔌 [WS] Routing ${token} -> ${targetData.url}`);

    // بازنویسی دقیق URL
    req.url = req.url.replace(token, targetData.realPath).replace(/\/\//g, '/');

    // تثبیت هدرهای وب‌سوکت برای جلوگیری از دخالت آژور
    req.headers['host'] = targetData.customHost;
    req.headers['connection'] = 'upgrade';
    req.headers['upgrade'] = 'websocket';

    // حذف هدرهای محدودکننده
    delete req.headers['origin'];
    delete req.headers['referer'];

    proxy.ws(req, socket, head, {
      target: targetData.url,
      headers: {
        host: targetData.customHost,
        connection: 'upgrade',
        upgrade: 'websocket',
      },
    });
  } else {
    socket.destroy();
  }
});

// 6. اجرای نهایی
const SECRET_PATH = `/telegraf/${bot.secretPathComponent()}`;
app.use(bot.webhookCallback(SECRET_PATH));

server.listen(PORT, async () => {
  console.log(`🚀 Azure Bot-Relay Listening on Port ${PORT}`);
  if (AZURE_DOMAIN !== 'localhost') {
    await bot.telegram.setWebhook(`https://${AZURE_DOMAIN}${SECRET_PATH}`);
  }
});
