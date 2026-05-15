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

// --- توابع کمکی سنایی ---
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
  const cookie = await xuiLogin();
  const res = await xuiClient.get(
    `${XUI_URL}/panel/api/inbounds/getClientTraffics/${email}`,
    { headers: { Cookie: cookie } },
  );
  return res.data.success && res.data.obj
    ? ((res.data.obj.up + res.data.obj.down) / 1024 ** 3).toFixed(3)
    : 0;
}

// --- سیستم کش ---
let routingCache = {};
async function updateRoutingCache() {
  try {
    const { data } = await supabase
      .from('telegram_users')
      .select('relay_token');
    if (data) {
      const newCache = {};
      const cleanHost = TARGET_SERVER.split(':')[0];
      const finalUrl = `https://${TARGET_SERVER}`; // فرض بر 443 و TLS سنایی
      data.forEach((u) => {
        newCache[`/${u.relay_token}`] = {
          url: finalUrl,
          realPath: TARGET_PATH,
          host: cleanHost,
        };
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

// --- ربات تلگرام ---
const checkJoin = async (ctx) => {
  if (REQUIRED_CHANNELS.length === 0) return true;
  for (const c of REQUIRED_CHANNELS) {
    try {
      const m = await bot.telegram.getChatMember(c.trim(), ctx.from.id);
      if (['left', 'kicked'].includes(m.status)) return false;
    } catch (e) {
      return false;
    }
  }
  return true;
};

const mainMenu = Markup.inlineKeyboard([
  [Markup.button.callback('🚀 دریافت کانفیگ', 'get_config')],
  [Markup.button.callback('📊 استعلام مصرف', 'check_usage')],
]);

bot.start(async (ctx) => {
  if (!(await checkJoin(ctx)))
    return ctx.reply(
      '⚠️ ابتدا عضو کانال شوید.',
      Markup.inlineKeyboard(
        REQUIRED_CHANNELS.map((c) => [
          Markup.button.url(
            `عضویت در ${c}`,
            `https://t.me/${c.replace('@', '')}`,
          ),
        ]),
      ),
    );
  ctx.reply(`سلام ${ctx.from.first_name}! خوش آمدید.`, mainMenu);
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
      const uuid = uuidv4(),
        token = `usr-${Math.random().toString(36).substr(2, 8)}`;
      await createSanaeiClient(uuid, tgId, 0.5);
      const { data } = await supabase
        .from('telegram_users')
        .insert([{ tg_id: tgId, uuid, relay_token: token }])
        .select()
        .single();
      user = data;
      await updateRoutingCache();
    } catch (e) {
      return ctx.reply('خطا در ساخت کانفیگ.');
    }
  }
  const vless = `vless://${user.uuid}@${AZURE_DOMAIN}:443?type=ws&security=tls&path=/${user.relay_token}&host=${AZURE_DOMAIN}&sni=${AZURE_DOMAIN}#Azure-${tgId}`;
  ctx.reply(`✅ کانفیگ شما:\n\n<code>${vless}</code>`, {
    parse_mode: 'HTML',
    ...mainMenu,
  });
});

bot.action('check_usage', async (ctx) => {
  const usage = await getSanaeiUsage(`tg_${ctx.from.id}`);
  ctx.reply(`📊 مصرف: ${usage} GB / 0.500 GB`, mainMenu);
});

// --- رله پروکسی (دقیقاً مشابه نسخه ساده و کاربری) ---
const app = express();
const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  secure: false,
  ws: true,
});

app.use((req, res, next) => {
  if (req.url.startsWith('/telegraf') || req.url.startsWith('/api'))
    return next();
  const token = '/' + req.url.split('/')[1].split('?')[0];
  const targetData = routingCache[token];
  if (targetData) {
    req.url = req.url.replace(token, targetData.realPath).replace(/\/\//g, '/');
    req.headers['host'] = targetData.host;
    proxy.web(req, res, { target: targetData.url });
  } else {
    res.status(200).send('Azure Relay Active');
  }
});

const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  const token = '/' + req.url.split('/')[1].split('?')[0];
  const targetData = routingCache[token];
  if (targetData) {
    req.url = req.url.replace(token, targetData.realPath).replace(/\/\//g, '/');
    req.headers['host'] = targetData.host;
    proxy.ws(req, socket, head, { target: targetData.url });
  } else {
    socket.destroy();
  }
});

const SECRET_PATH = `/telegraf/${bot.secretPathComponent()}`;
app.use(bot.webhookCallback(SECRET_PATH));

server.listen(PORT, async () => {
  console.log(`🚀 Relay running on ${PORT}`);
  if (AZURE_DOMAIN !== 'localhost')
    await bot.telegram.setWebhook(`https://${AZURE_DOMAIN}${SECRET_PATH}`);
});
