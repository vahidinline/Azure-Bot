const { Telegraf, Markup } = require('telegraf');
const { v4: uuidv4 } = require('uuid');

// تابع کمکی برای چک کردن عضویت در کانال‌ها
async function checkForceJoin(ctx, bot, channels) {
  if (!channels || channels.length === 0) return true;
  const userId = ctx.from.id;

  for (const channel of channels) {
    try {
      const member = await bot.telegram.getChatMember(channel.trim(), userId);
      if (['left', 'kicked'].includes(member.status)) return false;
    } catch (e) {
      console.error(`Force Join Error for ${channel}:`, e.message);
      return false; // اگر ربات در کانال ادمین نباشد یا کانال وجود نداشته باشد
    }
  }
  return true;
}

function setupBot(bot, supabase, xuiFunctions, config) {
  const CHANNELS = (process.env.REQUIRED_CHANNELS || '')
    .split(',')
    .filter((c) => c.trim() !== '');

  // دکمه‌های منوی اصلی
  const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('🚀 دریافت / مشاهده کانفیگ', 'get_config')],
    [Markup.button.callback('📊 وضعیت مصرف و اکانت', 'check_status')],
    [Markup.button.callback('💎 ارتقا به VIP (نامحدود)', 'buy_vip')],
    [Markup.button.url('🎧 پشتیبانی آنلاین', 'https://t.me/vahid')],
  ]);

  // هندل کردن دستور /start
  bot.start(async (ctx) => {
    const isJoined = await checkForceJoin(ctx, bot, CHANNELS);

    if (!isJoined) {
      return ctx.reply(
        `👋 خوش آمدید!\n\n⚠️ برای استفاده از خدمات ربات، ابتدا باید در کانال‌های زیر عضو شوید:`,
        Markup.inlineKeyboard([
          ...CHANNELS.map((c) => [
            Markup.button.url(
              `📢 عضویت در ${c}`,
              `https://t.me/${c.replace('@', '')}`,
            ),
          ]),
          [Markup.button.callback('✅ عضو شدم! تایید کن', 'get_config')],
        ]),
      );
    }

    ctx.reply(
      `سلام ${ctx.from.first_name} عزیز! 🌹\nبه سرویس هوشمند X-Ray آژور خوش آمدید.\n\nیکی از گزینه‌های زیر را انتخاب کنید:`,
      mainMenu,
    );
  });

  // هندل کردن دکمه دریافت/مشاهده کانفیگ
  bot.action('get_config', async (ctx) => {
    const tgId = ctx.from.id;
    const isJoined = await checkForceJoin(ctx, bot, CHANNELS);
    if (!isJoined)
      return ctx.answerCbQuery('❌ ابتدا در کانال‌ها عضو شوید!', {
        show_alert: true,
      });

    await ctx.answerCbQuery('⏳ در حال پردازش...');

    let { data: user } = await supabase
      .from('telegram_users')
      .select('*')
      .eq('tg_id', tgId)
      .single();

    if (!user) {
      try {
        const uuid = uuidv4();
        const relayToken = `usr-${Math.random().toString(36).substr(2, 8)}`;
        await xuiFunctions.createClient(uuid, tgId, 0.5);
        const { data: newUser } = await supabase
          .from('telegram_users')
          .insert([{ tg_id: tgId, uuid, relay_token: relayToken }])
          .select()
          .single();
        user = newUser;
        xuiFunctions.refreshCache(); // آپدیت کش رله
      } catch (err) {
        return ctx.reply('❌ خطا در ساخت کانفیگ جدید. مجدداً تلاش کنید.');
      }
    }

    const vless = `vless://${user.uuid}@${config.domain}:443?type=ws&security=tls&path=/${user.relay_token}&host=${config.domain}&sni=${config.domain}#Azure-${tgId}`;

    ctx.reply(
      `✅ <b>اطلاعات سرویس شما:</b>\n\n🆔 UUID: <code>${user.uuid}</code>\n🔗 Path: <code>/${user.relay_token}</code>\n\n🔹 <b>کانفیگ مخصوص V2ray:</b>\n<code>${vless}</code>\n\n📌 <i>نکته: روزانه ۵۰۰ مگابایت ترافیک رایگان دارید.</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔙 بازگشت به منو', 'back_home')],
        ]),
      },
    );
  });

  // هندل کردن وضعیت مصرف
  bot.action('check_status', async (ctx) => {
    const tgId = ctx.from.id;
    try {
      const usage = await xuiFunctions.getUsage(`tg_${tgId}`);
      const { data: user } = await supabase
        .from('telegram_users')
        .select('is_premium')
        .eq('tg_id', tgId)
        .single();
      const limit = user?.is_premium
        ? '💎 نامحدود (VIP)'
        : '🎁 ۲۰۰ مگابایت (روزانه)';

      ctx.editMessageText(
        `📊 <b>گزارش مصرف لحظه‌ای:</b>\n\n👤 کاربر: <code>${ctx.from.first_name}</code>\n📈 مصرف شده: <code>${usage} GB</code>\n🔋 سقف مجاز: <code>${limit}</code>\n\n✅ سرویس شما فعال است.`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔙 بازگشت', 'back_home')],
          ]),
        },
      );
    } catch (e) {
      ctx.answerCbQuery('❌ ابتدا کانفیگ دریافت کنید.');
    }
  });

  bot.action('back_home', (ctx) => {
    ctx.editMessageText('یکی از گزینه‌های زیر را انتخاب کنید:', mainMenu);
  });
}

module.exports = { setupBot };
