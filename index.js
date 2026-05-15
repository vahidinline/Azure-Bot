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

// ==========================================
// 1. تنظیمات اولیه و متغیرها
// ==========================================
const PORT = process.env.PORT || process.env.WEBSITES_PORT || 8080;
const AZURE_DOMAIN = process.env.WEBSITE_HOSTNAME || 'localhost';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);
const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());

// تنظیمات سنایی (پیش‌فرض سرور شما)
const XUI_URL = (process.env.XUI_URL || '').replace(/\/$/, '');
const XUI_INBOUND_ID = parseInt(process.env.XUI_INBOUND_ID || 5);
const TARGET_SERVER = process.env.DEFAULT_TARGET_SERVER || 'cdn.kidy.care:443';
const TARGET_PATH = process.env.DEFAULT_TARGET_PATH || '/azure-relay/';

// ==========================================
// 2. توابع ارتباط با API سنایی
// ==========================================
const xuiClient = axios.create({
  timeout: 12000,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }), // دور زدن خطای SSL سنایی
  headers: { 'User-Agent': 'Azure-SaaS-Bot', Accept: 'application/json' },
});

async function xuiLogin() {
  const XUI_URL = (process.env.XUI_URL || '').replace(/\/$/, '');
  const payload = new URLSearchParams({
    username: process.env.XUI_USERNAME,
    password: process.env.XUI_PASSWORD,
  });

  try {
    const res = await xuiClient.post(`${XUI_URL}/login`, payload, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      maxRedirects: 0, // 🔴 بسیار مهم: جلوگیری از دنبال کردن ریدایرکت
    });

    // اگر پنل مستقیما 200 داد
    if (res.data && res.data.success === false) throw new Error(res.data.msg);

    const cookies = res.headers['set-cookie'];
    if (!cookies || cookies.length === 0)
      throw new Error('سرور لاگین شد اما کوکی نداد');
    return cookies[0].split(';')[0];
  } catch (error) {
    // پنل سنایی معمولاً در صورت لاگین موفق، 302 ریدایرکت می‌دهد که اینجا شکار می‌شود
    if (
      error.response &&
      (error.response.status === 302 || error.response.status === 303)
    ) {
      const cookies = error.response.headers['set-cookie'];
      if (cookies && cookies.length > 0) {
        return cookies[0].split(';')[0];
      }
      throw new Error('ریدایرکت انجام شد اما کوکی در هدر نبود');
    }

    // اگر خطای دیگری بود (مثلا یوزر و پسورد اشتباه)
    const errMsg = error.response?.data?.msg || error.message;
    throw new Error(errMsg);
  }
}

async function createSanaeiClient(uuid, tgId, gbLimit) {
  const cookie = await xuiLogin();
  const limitBytes = gbLimit > 0 ? gbLimit * 1024 * 1024 * 1024 : 0;
  const email = `tg_${tgId}`;

  const clientSettings = {
    id: uuid,
    flow: '',
    email: email,
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
  return email;
}

// آپدیت کردن حجم کاربر (برای زمانی که پریمیوم می‌خرد)
async function updateSanaeiClientLimit(uuid, tgId, gbLimit) {
  const cookie = await xuiLogin();
  const limitBytes = gbLimit > 0 ? gbLimit * 1024 * 1024 * 1024 : 0;
  const email = `tg_${tgId}`;

  const clientSettings = {
    id: uuid,
    flow: '',
    email: email,
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
// 3. سیستم کش مسیرها (برای پروکسی)
// ==========================================
let routingCache = {};

async function updateRoutingCache() {
  try {
    // خواندن کاربرانی که ربات تلگرام برایشان اکانت ساخته
    const { data, error } = await supabase
      .from('telegram_users')
      .select('relay_token, is_premium');
    if (error) return;

    if (data) {
      const newCache = {};
      data.forEach((u) => {
        let cleanTarget = TARGET_SERVER.replace(':443', '').replace(':80', '');
        let finalUrl = cleanTarget.startsWith('http')
          ? cleanTarget
          : `https://${cleanTarget}`;

        // کش کردن مسیر مخصوص به کاربر برای رله ترافیک
        newCache[`/${u.relay_token}`] = {
          url: finalUrl,
          realPath: TARGET_PATH,
          customHost: cleanTarget,
        };
      });
      routingCache = newCache;
      console.log(
        `✅ [CRON] Cache Updated. Active Telegram Tunnels: ${Object.keys(routingCache).length}`,
      );
    }
  } catch (e) {
    console.error('❌ Cache Error:', e.message);
  }
}

updateRoutingCache();
setInterval(updateRoutingCache, 60000);

// ==========================================
// 4. ربات تلگرام (مغز متفکر)
// ==========================================
bot.start(async (ctx) => {
  const tgId = ctx.from.id;
  let { data: user } = await supabase
    .from('telegram_users')
    .select('*')
    .eq('tg_id', tgId)
    .single();

  if (!user) {
    const msg = await ctx.reply('⏳ در حال ساخت تونل اختصاصی شما...');
    const uuid = uuidv4();
    const relayToken = `usr-${Math.random().toString(36).substr(2, 8)}`;

    try {
      await createSanaeiClient(uuid, tgId, 0.5); // حجم روزانه 0.5 گیگ
      await supabase
        .from('telegram_users')
        .insert([{ tg_id: tgId, uuid, relay_token: relayToken }]);
      user = { uuid, relay_token: relayToken, is_premium: false };
      ctx.deleteMessage(msg.message_id);
    } catch (err) {
      console.error('🔴 خطای ساخت کلاینت:', err.message);
      return ctx.reply(
        `❌ خطا در اتصال به سرور مرکزی.\nدلیل فنی: ${err.message}`,
      );
    }
  }

  const config = `vless://${user.uuid}@${AZURE_DOMAIN}:443?type=ws&security=tls&path=/${user.relay_token}&host=${AZURE_DOMAIN}&sni=${AZURE_DOMAIN}#FreeSaaS-${tgId}`;

  ctx.reply(
    `✅ <b>کانفیگ VLESS شما آماده است:</b>\n\n<code>${config}</code>\n\n📌 <b>قوانین:</b>\nشما روزانه ۵۰۰ مگابایت حجم رایگان دارید که هر شب ساعت ۱۲ صفر می‌شود.\n\n👇 برای خرید حجم نامحدود (VIP) یا استعلام روی دکمه‌های زیر کلیک کنید:`,
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
  const tgId = ctx.from.id;
  try {
    const usage = await getSanaeiUsage(`tg_${tgId}`);
    const { data: user } = await supabase
      .from('telegram_users')
      .select('is_premium')
      .eq('tg_id', tgId)
      .single();
    const limit = user?.is_premium ? 'نامحدود (VIP)' : '۰.۵ گیگابایت (روزانه)';

    ctx.editMessageText(
      `📊 <b>وضعیت مصرف شما:</b>\n\n🔹 حجم مصرف شده: <code>${usage} GB</code>\n🔹 سقف مجاز: <code>${limit}</code>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔙 بازگشت', 'back_home')],
        ]),
      },
    );
  } catch (e) {
    ctx.answerCbQuery('❌ خطا در دریافت اطلاعات');
  }
});

bot.action('buy_vip', async (ctx) => {
  const tgId = ctx.from.id;
  try {
    const apiKey = process.env.NOWPAYMENTS_API_KEY;
    const apiUrl =
      process.env.NOWPAYMENTS_API_URL ||
      'https://api.nowpayments.io/v1/invoice';

    const response = await axios.post(
      apiUrl,
      {
        price_amount: 5,
        price_currency: 'usd',
        pay_currency: 'trx',
        order_id: tgId.toString(),
        order_description: 'خرید اکانت VIP نامحدود Xray',
        ipn_callback_url: `https://${AZURE_DOMAIN}/api/webhook`,
        success_url: `https://t.me/${ctx.botInfo.username}`,
        cancel_url: `https://t.me/${ctx.botInfo.username}`,
      },
      { headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' } },
    );

    ctx.editMessageText(
      `💎 <b>خرید اشتراک VIP نامحدود</b>\n\nمبلغ: ۵ تتر (USDT-TRC20)\n\nپس از پرداخت، اکانت شما فوراً و به صورت اتوماتیک نامحدود خواهد شد.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.url(
              '💳 پرداخت آنلاین (Crypto)',
              response.data.invoice_url,
            ),
          ],
          [Markup.button.callback('🔙 بازگشت', 'back_home')],
        ]),
      },
    );
  } catch (e) {
    ctx.answerCbQuery('❌ خطا در ارتباط با درگاه پرداخت');
  }
});

bot.action('back_home', (ctx) => {
  ctx.editMessageText(
    'به منوی اصلی بازگشتید. برای دریافت کانفیگ /start را بزنید.',
  );
});

// ==========================================
// 5. درگاه پرداخت (وب‌هوک NowPayments)
// ==========================================
app.post('/api/webhook', async (req, res) => {
  const sig = req.headers['x-nowpayments-sig'];
  if (!sig) return res.status(400).send('No signature');
  const hmac = crypto.createHmac('sha512', process.env.NOWPAYMENTS_IPN_SECRET);
  hmac.update(JSON.stringify(req.body));
  if (hmac.digest('hex') !== sig)
    return res.status(403).send('Invalid signature');

  if (
    req.body.payment_status === 'finished' ||
    req.body.payment_status === 'confirmed'
  ) {
    const tgId = parseInt(req.body.order_id);
    // آپدیت دیتابیس
    const { data: user } = await supabase
      .from('telegram_users')
      .update({ is_premium: true })
      .eq('tg_id', tgId)
      .select()
      .single();
    if (user) {
      // حذف محدودیت حجم در سنایی
      await updateSanaeiClientLimit(user.uuid, tgId, 0);

      // ارسال پیام موفقیت به کاربر تلگرام
      bot.telegram.sendMessage(
        tgId,
        '🎉 پرداخت شما تایید شد!\nاکانت شما به VIP نامحدود ارتقا یافت.',
      );
    }
  }
  res.status(200).send('OK');
});

// ==========================================
// 6. رله ترافیک Xray (WebSockets Proxy)
// ==========================================
const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  secure: false,
  ws: true,
  xfwd: true,
  ignorePath: false,
});
proxy.on('proxyRes', (pRes) => (pRes.headers['X-Accel-Buffering'] = 'no'));
proxy.on('error', (err, req, res) => {
  if (res && res.writeHead) {
    res.writeHead(502);
    res.end('Gateway Error');
  }
});

function extractToken(url) {
  if (!url) return '/';
  const cleanUrl = url.split('?')[0].replace(/\/+/g, '/');
  const parts = cleanUrl.split('/');
  return parts.length > 1 && parts[1] ? `/${parts[1]}` : '/';
}

app.use((req, res, next) => {
  // مسیرهای تلگرام و API وب‌هوک را نادیده بگیر
  if (req.url.startsWith('/telegraf/') || req.url.startsWith('/api/'))
    return next();

  const token = extractToken(req.url);
  const targetData = routingCache[token];

  if (targetData && targetData.url) {
    try {
      req.url = req.url
        .replace(token, targetData.realPath)
        .replace(/\/\//g, '/');
      req.headers['host'] =
        targetData.customHost || new URL(targetData.url).host;
      delete req.headers['origin'];
      proxy.web(req, res, { target: targetData.url });
    } catch (err) {
      res.status(500).send('Error');
    }
  } else {
    res.status(404).send('Azure SaaS Relay');
  }
});

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  const token = extractToken(req.url);
  const targetData = routingCache[token];

  if (targetData && targetData.url) {
    try {
      req.url = req.url
        .replace(token, targetData.realPath)
        .replace(/\/\//g, '/');
      req.headers['host'] =
        targetData.customHost || new URL(targetData.url).host;
      delete req.headers['origin'];

      proxy.ws(req, socket, head, { target: targetData.url });
    } catch (err) {
      socket.destroy();
    }
  } else {
    socket.destroy();
  }
});

// ==========================================
// 7. اجرای کرون جاب و وب‌هوک تلگرام
// ==========================================
// مسیر مخفی وب‌هوک تلگرام
const SECRET_PATH = `/telegraf/${bot.secretPathComponent()}`;
app.use(bot.webhookCallback(SECRET_PATH));

// هر شب ساعت 12:00 حجم کسانی که پریمیوم نیستند صفر می‌شود
cron.schedule('0 0 * * *', async () => {
  console.log('🔄 ریست کردن حجم روزانه کاربران رایگان...');
  const { data: freeUsers } = await supabase
    .from('telegram_users')
    .select('tg_id')
    .eq('is_premium', false);
  if (freeUsers) {
    for (let u of freeUsers) {
      try {
        await resetSanaeiTraffic(`tg_${u.tg_id}`);
      } catch (e) {
        /* ignore */
      }
    }
  }
});

server.listen(PORT, async () => {
  console.log(`🚀 Azure Xray Bot-Relay Running on Port ${PORT}`);
  // ثبت وب‌هوک در تلگرام
  if (process.env.WEBSITE_HOSTNAME) {
    const webhookUrl = `https://${process.env.WEBSITE_HOSTNAME}${SECRET_PATH}`;
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`🔗 Telegram Webhook set to: ${webhookUrl}`);
  }
});
