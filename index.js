const { Markup } = require('telegraf');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

async function checkForceJoin(ctx, bot, channels) {
  if (!channels || channels.length === 0) return true;
  for (const channel of channels) {
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

function setupBot(bot, supabase, xui, config) {
  const CHANNELS = (process.env.REQUIRED_CHANNELS || '')
    .split(',')
    .filter((c) => c.trim());

  const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('🚀 دریافت / مشاهده کانفیگ', 'get_config')],
    [Markup.button.callback('📊 وضعیت مصرف', 'check_status')],
    [Markup.button.callback('💎 خرید اشتراک VIP', 'buy_vip')],
  ]);

  bot.start(async (ctx) => {
    const isJoined = await checkForceJoin(ctx, bot, CHANNELS);
    if (!isJoined) {
      return ctx.reply(
        '⚠️ برای استفاده، ابتدا در کانال‌های ما عضو شوید:',
        Markup.inlineKeyboard([
          ...CHANNELS.map((c) => [
            Markup.button.url(
              `📢 عضویت در ${c}`,
              `https://t.me/${c.replace('@', '')}`,
            ),
          ]),
          [Markup.button.callback('✅ عضو شدم', 'get_config')],
        ]),
      );
    }
    ctx.reply(
      `سلام ${ctx.from.first_name}! به سرویس آژور خوش آمدید.`,
      mainMenu,
    );
  });

  bot.action('get_config', async (ctx) => {
    const tgId = ctx.from.id;
    if (!(await checkForceJoin(ctx, bot, CHANNELS)))
      return ctx.answerCbQuery('❌ ابتدا عضو شوید');

    let { data: user } = await supabase
      .from('telegram_users')
      .select('*')
      .eq('tg_id', tgId)
      .single();
    if (!user) {
      try {
        const uuid = uuidv4();
        const relayToken = `usr-${Math.random().toString(36).substr(2, 8)}`;
        await xui.createClient(uuid, tgId, 0.5);
        const { data } = await supabase
          .from('telegram_users')
          .insert([{ tg_id: tgId, uuid, relay_token: relayToken }])
          .select()
          .single();
        user = data;
        xui.refreshCache();
      } catch (e) {
        return ctx.reply('خطا در ساخت سرویس.');
      }
    }

    const vless = `vless://${user.uuid}@${config.domain}:443?type=ws&security=tls&path=/${user.relay_token}&host=${config.domain}&sni=${config.domain}#Azure-${tgId}`;
    ctx.reply(`✅ کانفیگ شما:\n\n<code>${vless}</code>`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔙 بازگشت', 'back_home')],
      ]),
    });
  });

  bot.action('check_status', async (ctx) => {
    try {
      const usage = await xui.getUsage(`tg_${ctx.from.id}`);
      const { data } = await supabase
        .from('telegram_users')
        .select('is_premium')
        .eq('tg_id', ctx.from.id)
        .single();
      ctx.reply(
        `📊 مصرف: ${usage} GB\n🔋 سقف: ${data?.is_premium ? 'نامحدود' : '0.5GB'}`,
      );
    } catch (e) {
      ctx.answerCbQuery('ابتدا کانفیگ بگیرید');
    }
  });

  bot.action('buy_vip', async (ctx) => {
    try {
      const res = await axios.post(
        'https://api.nowpayments.io/v1/invoice',
        {
          price_amount: 5,
          price_currency: 'usd',
          pay_currency: 'trx',
          order_id: ctx.from.id.toString(),
          ipn_callback_url: `https://${config.domain}/api/webhook`,
          success_url: `https://t.me/${ctx.botInfo.username}`,
        },
        { headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY } },
      );
      ctx.reply(
        'برای خرید VIP روی لینک زیر کلیک کنید:',
        Markup.inlineKeyboard([
          [Markup.button.url('💳 پرداخت آنلاین', res.data.invoice_url)],
        ]),
      );
    } catch (e) {
      ctx.reply('خطا در درگاه پرداخت.');
    }
  });

  bot.action('back_home', (ctx) =>
    ctx.editMessageText('گزینه مورد نظر را انتخاب کنید:', mainMenu),
  );
}

module.exports = { setupBot };
