require('dotenv').config();
const axios = require('axios');
const Fastify = require('fastify');
const fastify = Fastify({ logger: true });
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
const User = require('./models/User');
const adminPanel= require('./admin'); 
const REQUIRED_CHANNELS = (process.env.REQUIRED_CHANNELS || '').split(',').map(ch => ch.trim()).filter(Boolean);
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
const tempReferrers = new Map(); 


const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { webHook: true });

const WEBHOOK_PATH = `/webhook/${token}`;
const FULL_WEBHOOK_URL = `${process.env.PUBLIC_URL}${WEBHOOK_PATH}`;

// Webhook endpoint
fastify.post(WEBHOOK_PATH, (req, reply) => {
  try {
    bot.processUpdate(req.body);  // Telegram update-larni botga uzatish juda muhim
    console.log('Update processed:', req.body);
    reply.code(200).send();       // Telegram API uchun 200 OK javob qaytarish kerak
  } catch (error) {
    console.error('Error processing update:', error);
    reply.sendStatus(500);
  }
});

// Health check endpoint
fastify.get('/healthz', (req, reply) => {
  reply.send({ status: 'ok' });
});

// Serverni ishga tushirish va webhook o‘rnatish
fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' }, async (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }

  fastify.log.info(`Server listening at ${address}`);

  try {
const response = await axios.post(`https://api.telegram.org/bot${token}/setWebhook`, null, {
  params: { url: FULL_WEBHOOK_URL }
});

    if (response.data.ok) {
      fastify.log.info('Webhook successfully set:', response.data);
    } else {
      fastify.log.error('Failed to set webhook:', response.data);
    }
  } catch (error) {
    fastify.log.error('Error setting webhook:', error.message);
  }
});
bot.getMe().then((botInfo) => {
  bot.me = botInfo;
  console.log(`🤖 Bot ishga tushdi: @${bot.me.username}`);
}).catch((err) => {
  console.error("Bot ma'lumotini olishda xatolik:", err.message);
});
adminPanel(bot)
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('MongoDBga ulandi');
}).catch(err => {
  console.error('MongoDB ulanishda xatolik:', err);
  process.exit(1);
});
// Obuna tekshiruvchi
async function isUserSubscribed(userId) {
  if (!REQUIRED_CHANNELS.length) return true; 

  for (const channel of REQUIRED_CHANNELS) {
    try {
      const res = await bot.getChatMember(channel, userId);
      if (!['member', 'creator', 'administrator'].includes(res.status)) {
        return false; 
      }
    } catch (err) {
      console.error(`Obuna tekshirishda xatolik [${channel}]:`, err.message);
      return false;
    }
  }

  return true;
}
async function getSubscriptionMessage() {
  const buttons = [];

  for (const channel of REQUIRED_CHANNELS) {
    try {
      const chat = await bot.getChat(channel);
      const title = chat.title || channel;
      const channelLink = `https://t.me/${channel.replace('@', '')}`;
      buttons.push([{ text: `${title}`, url: channelLink }]);
    } catch (err) {
      console.error(`Kanal nomini olishda xatolik: ${channel}`, err.message);
      // fallback
      buttons.push([{ text: `${channel}`, url: `https://t.me/${channel.replace('@', '')}` }]);
    }
  }

  buttons.push([{ text: '✅ Obuna bo‘ldim', callback_data: 'check_subscription' }]);

  return {
    text: `<b>❗ Botdan foydalanish uchun quyidagi kanallarga obuna bo‘ling:</b>`,
    options: {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  };
}


const receiveSite = 'https://receive-sms-online.info';
const PHONE_RE = /(\+?\d[\d\-\s()]{6,}\d)/g;
const timeoutOptions = { timeout: 15000 };

async function fetchHtml(url) {
  try {
    const res = await fetch(url, { ...timeoutOptions, redirect: 'follow' });
    return await res.text();
  } catch (err) {
    console.error('fetchHtml error', url, err && err.message);
    throw err;
  }
}

async function scrapeSite(url) {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const results = [];

    $('a').each((i, el) => {
      const $el = $(el);
      const text = $el.text().replace(/\s+/g, ' ').trim();
      if (!text) return;
      const matches = text.match(PHONE_RE);
      if (!matches) return;

      let href = $el.attr('href');
      if (href && !href.startsWith('http')) {
        href = new URL(href, url).toString();
      }

      for (const m of matches) {
        const phone = m.replace(/[^\d+]/g, '');
        results.push({ site: url, phone, href });
      }
    });

    const seen = new Map();
    const unique = [];
    for (const r of results) {
      if (!seen.has(r.phone)) {
        seen.set(r.phone, true);
        unique.push(r);
      }
    }
    return unique;
  } catch (err) {
    console.error('scrapeSite failed', url, err && err.message);
    return [];
  }
}

function parseMessagesGeneric(html) {
  const $ = cheerio.load(html);
  const messages = [];
  $('#messages > div.message').each((i, el) => {
    const $el = $(el);
    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (text) messages.push({ text });
  });
  return messages;
}

async function fetchMessagesForItem(item) {
  if (!item.href) return { ok: false, error: 'HREF yo‘q' };
  try {
    const html = await fetchHtml(item.href);
    const msgs = parseMessagesGeneric(html);
    if (msgs.length) {
      return { ok: true, url: item.href, messages: msgs.slice(0, 10) };
    }
    return { ok: false, error: 'Xabarlar topilmadi' };
  } catch (err) {
    return { ok: false, error: err.message || 'Xatolik' };
  }
}

async function getUser(userId) {
  return User.findOne({ userId }).exec();
}

async function addUser(userId, referrerId = null) {
  let exists = await getUser(userId);
  if (exists) return exists;

  const userDoc = new User({
    userId,
    referals: [],
    referalCount: 0,
    referrer: null
  });

if (referrerId && referrerId !== userId) {
  const referrer = await getUser(referrerId);

  if (referrer) {
    userDoc.referrer = referrerId;
    await User.updateOne(
      { userId: referrerId },
      { $addToSet: { referals: userId }, $inc: { referalCount: 1 } }
    );
  } else {
    // Agar referrer bazada yo'q bo‘lsa, uni yaratamiz
    await addUser(referrerId);
    await User.updateOne(
      { userId: referrerId },
      { $addToSet: { referals: userId }, $inc: { referalCount: 1 } }
    );
  }

  userDoc.referrer = referrerId;

  // Referal haqida xabar
  bot.sendMessage(referrerId, `<b>🎉 Sizga yangi referal qo'shildi!</b>\n<a href='tg://user?id=${userId}'>👤Ro'yxatdan o'tdi : ${userId}</a> `, {parse_mode : 'HTML'});
}

  await userDoc.save();
  return userDoc;
}

async function decrementReferals(userId, count = 5) {
  const user = await getUser(userId);
  if (!user || user.referalCount < count) return false;

  const newReferals = user.referals.slice(count);
  await User.updateOne(
    { userId },
    { $set: { referals: newReferals }, $inc: { referalCount: -count } }
  );
  return true;
}
function mainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📱 Raqam olish 🛎', callback_data: 'get_number' }],
        [{text: `🌹 Sovg'a olish 🧸`, callback_data : 'get_gift'}],
        [{ text: '👥 Referal tizimi 🔖', callback_data: 'ref_system' }],
      ]
    }
  };
}

async function referalMenu(userId) {
  const user = await getUser(userId);
  const referalCount = user?.referalCount || 0;
  const refLink = `https://t.me/${bot.me.username}?start=${userId}`;

  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: `Referallar soni: ${referalCount}`, callback_data: 'ref_count' }],
        [{ text: '📝 Referal havola', callback_data: 'ref_link' }],
        [{ text: '⬅️ Orqaga', callback_data: 'back_to_main' }],
      ]
    },
    text: `👥 Sizning referallar soningiz: ${referalCount}\n🔗 Havolangiz:\n<code>${refLink}</code>\nUstiga bosilsa nusxa olinadi👆🏻`
  };
}
const userSelections = new Map();
const gifts = {
  '15stars_heart' : {title : '💝', price : 15},
  '15stars_bear': {title : '🧸', price : 15},
  '25stars_rose' : {title : '🌹', price : 25},
  '25stars_gift' : {title : '🎁', price : 25}
}
bot.onText(/\/start(?: (\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const referrerId = match ? parseInt(match[1], 10) : null;
  if (referrerId) {
    tempReferrers.set(userId, referrerId);
  }
  
  if (!(await isUserSubscribed(userId))) {
    const sub = await getSubscriptionMessage();
    return bot.sendMessage(chatId, sub.text, sub.options);
  }
  
  await addUser(userId, referrerId);
  await bot.sendMessage(chatId, `🐳`, mainMenu());
});

bot.on('callback_query', async (callbackQuery) => {
  const data = callbackQuery.data;
  const msg = callbackQuery.message;
  const userId = callbackQuery.from.id;
  const chatId = msg.chat.id;

  // 🔒 Obuna tekshirish
if (data === 'check_subscription') {
  if (await isUserSubscribed(userId)) {
    const referrerId = tempReferrers.get(userId) || null;
    await addUser(userId, referrerId);
    tempReferrers.delete(userId);
    return bot.sendMessage(chatId, '✅ Obuna tasdiqlandi!', mainMenu());
  } else {
    const sub = await getSubscriptionMessage();
    return bot.sendMessage(chatId, sub.text, sub.options);
  }
}


  if (data === 'back_to_main') {
    return bot.editMessageText('Asosiy menyu', {
      chat_id: chatId,
      message_id: msg.message_id,
      ...mainMenu()
    });
  }

  if (data === 'ref_system') {
    const menu = await referalMenu(userId);
    return bot.editMessageText(menu.text, {
      chat_id: chatId,
      message_id: msg.message_id,
      reply_markup: menu.reply_markup,
      parse_mode: 'HTML'
    });
  }

  if (data === 'ref_count') {
    const user = await getUser(userId);
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: `Sizda ${user?.referalCount || 0} ta referal bor.`
    });
  }

  if (data === 'ref_link') {
    const refLink = `https://t.me/${bot.me.username}?start=${userId}`;
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: `Sizning referal havolangiz: ${refLink}`,
      show_alert: true
    });
  }
  if (data === 'get_number') {
    const user = await getUser(userId);
    if (!user) {
      return bot.answerCallbackQuery(callbackQuery.id, {
        text: 'Iltimos /start buyrug‘ini yuboring.'
      });
    }

    if (user.referalCount < 10) {
      return bot.answerCallbackQuery(callbackQuery.id, {
        text: '🚫 Raqam olish uchun kamida 10 ta referalingiz bo‘lishi kerak.',
        show_alert: true
      });
    }

    await bot.answerCallbackQuery(callbackQuery.id, {
      text: '⏳ Raqamlar olinmoqda, iltimos kuting...'
    });

    const numbers = await scrapeSite(receiveSite);
    if (numbers.length === 0) {
      return bot.editMessageText('❌ Hech qanday raqam topilmadi.', {
        chat_id: chatId,
        message_id: msg.message_id
      });
    }

    const topNumbers = numbers.slice(0, 5);
    const buttons = topNumbers.map((item, idx) => {
      return [{ text: item.phone, callback_data: `select_number_${idx}` }];
    });
    buttons.push([{ text: '⬅️ Orqaga', callback_data: 'back_to_main' }]);

    userSelections.set(userId, topNumbers);

    return bot.editMessageText('📱 Raqamni tanlang:', {
      chat_id: chatId,
      message_id: msg.message_id,
      reply_markup: { inline_keyboard: buttons }
    });
  }
if (data === 'get_gift') {
  const user = await getUser(userId);
  if (!user) {
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: 'Iltimos /start buyrug‘ini yuboring.'
    });
  }

  // Sovg'alar menyusini yaratish
  const giftButtons = Object.entries(gifts).map(([key, gift]) => {
    return [{ text: gift.title, callback_data: `gift_${key}` }];
  });
  giftButtons.push([{ text: '⬅️ Orqaga', callback_data: 'back_to_main' }]);

  return bot.editMessageText("⤵️ Sovg'alardan birini tanlang:", {
    chat_id: chatId,
    message_id: msg.message_id,
    reply_markup: { inline_keyboard: giftButtons }
  });
}
if (data.startsWith('gift_')) {
  const giftKey = data.slice(5);
  const gift = gifts[giftKey];

  if (!gift) {
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: '❌ Bunday sovg‘a topilmadi.'
    });
  }

  const user = await getUser(userId);
  if (!user) {
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: 'Iltimos /start buyrug‘ini yuboring.'
    });
  }

  if (user.referalCount < gift.price) {
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: `🚫 Bu sovg‘ani olish uchun kamida ${gift.price} ta referal kerak.`,
      show_alert: true
    });
  }

  return bot.editMessageText(
    `<b>✨ Siz ${gift.title} sovg‘asini tanladingiz.</b>\n<i>❗️Ushbu sovg‘ani olish uchun ${gift.price} ta referalingiz kamaytiriladi.\n\nSizga tashlab berilishi biroz vaqt olishi mumkin.</i>\n\n<b>Tasdiqlaysizmi?</b>`,
    {
      chat_id: chatId,
      message_id: msg.message_id,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Tasdiqlayman', callback_data: `confirm_gift_${giftKey}` }],
          [{ text: '⬅️ Orqaga', callback_data: 'get_gift' }]
        ]
      }
    }
  );
}

if (data.startsWith('confirm_gift_')) {
  const giftKey = data.slice('confirm_gift_'.length);
  const gift = gifts[giftKey];

  if (!gift) {
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: '❌ Sovg‘a topilmadi.'
    });
  }

  const user = await getUser(userId);
  if (!user || user.referalCount < gift.price) {
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: '❌ Yetarli referal yo‘q.',
      show_alert: true
    });
  }

  const success = await decrementReferals(userId, gift.price);
  if (!success) {
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: '❌ Referal kamaytirishda xatolik.',
      show_alert: true
    });
  }

  // 🟢 Foydalanuvchiga xabar
  await bot.editMessageText(
    `<b>🎉 Tabriklaymiz! Siz ${gift.title}sovg‘asini oldingiz!</b> \n<u>Referallaringizdan ${gift.price} tasi olib tashlandi.</u>\n\n <b><i>Sabrli bo'ling admin faol bo'lgach sizga buyurtmangizni yetkazib beradi.🌝</i></b>`,
    {
      chat_id: chatId,
      message_id: msg.message_id,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Asosiy menyuga', callback_data: 'back_to_main' }]
        ]
      }
    }
  );

  // 👤 Foydalanuvchi ma'lumotlari
  const fullName = `${callbackQuery.from.first_name || ''} ${callbackQuery.from.last_name || ''}`.trim();
  const username = callbackQuery.from.username ? `@${callbackQuery.from.username}` : 'yo‘q';

  const userInfoText = `
🎁 <b>Sovg‘a buyurtma qilindi</b>

🎉 Sovg‘a: <b>${gift.title}</b>
💸 Narxi: <b>${gift.price} referal</b>

🆔 ID: <code>${userId}</code>
👤 Ism: <a href="tg://user?id=${userId}"><b>${fullName}</b></a>
🔗 Username: ${username}
`.trim();

  // 👨‍💻 Adminlarga yuborish
  for (const adminId of ADMIN_IDS) {
    bot.sendMessage(adminId, userInfoText, { parse_mode: 'HTML' });
  }
}

  if (data.startsWith('select_number_')) {
    const idx = parseInt(data.split('_').pop(), 10);
    const selections = userSelections.get(userId);
    if (!selections || !selections[idx]) {
      return bot.answerCallbackQuery(callbackQuery.id, {
        text: '❌ Tanlangan raqam topilmadi.'
      });
    }

    const selected = selections[idx];
    userSelections.set(`${userId}_selected`, selected); // Tanlangan raqamni saqlash

    return bot.editMessageText(
        `<b>📞 Siz <code>${selected.phone}</code> raqamini tanladingiz.</b>
<blockquote>
<b><i>
❗️ Ushbu raqamni ishlatish uchun 10 ta referalingiz kamaytiriladi.

⚠️ Diqqat! Bu raqam ommaviy tarzda foydalaniladi. Quyidagi holatlar bo‘lishi mumkin:

• 🕐 Raqam ilgari boshqa foydalanuvchilar tomonidan ishlatilgan bo‘lishi mumkin.  
• 🔐 Ba’zi servislar ikki bosqichli himoya (2FA) yoki parol bilan himoyalangan bo‘lishi mumkin.  
• 📩 Kod yuborilishi kafolatlanmaydi — bu servisga, raqamga va vaqtga bog‘liq.  
• ⌛ Kod kechikishi yoki umuman kelmasligi ehtimoli bor.  
• ❌ Barcha xizmatlar bu raqamlarni qabul qilavermasligi mumkin.

📌 Ushbu raqamni tanlab, siz yuqoridagi holatlarni tushunganingizni va roziligingizni bildirgan bo‘lasiz.
</i></b>
</blockquote>
<b>Davom etishni xohlaysizmi?</b>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode : 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Roziman', callback_data: 'confirm_number' }],
            [{ text: '⬅️ Orqaga', callback_data: 'back_to_main' }]
          ]
        }
      }
    );
  }
  if (data.startsWith('select_number_')) {
    const idx = parseInt(data.split('_').pop(), 10);
    const selections = userSelections.get(userId);
    if (!selections || !selections[idx]) {
      return bot.answerCallbackQuery(callbackQuery.id, {
        text: '❌ Tanlangan raqam topilmadi.'
      });
    }

    const selected = selections[idx];
    userSelections.set(`${userId}_selected`, selected); // Tanlangan raqamni saqlash

    return bot.editMessageText(
        `<b>📞 Siz <code>${selected.phone}</code> raqamini tanladingiz.</b>
<blockquote>
<b><i>
❗️ Ushbu raqamni ishlatish uchun 10 ta referalingiz kamaytiriladi.

⚠️ Diqqat! Bu raqam ommaviy tarzda foydalaniladi. Quyidagi holatlar bo‘lishi mumkin:

• 🕐 Raqam ilgari boshqa foydalanuvchilar tomonidan ishlatilgan bo‘lishi mumkin.  
• 🔐 Ba’zi servislar ikki bosqichli himoya (2FA) yoki parol bilan himoyalangan bo‘lishi mumkin.  
• 📩 Kod yuborilishi kafolatlanmaydi — bu servisga, raqamga va vaqtga bog‘liq.  
• ⌛ Kod kechikishi yoki umuman kelmasligi ehtimoli bor.  
• ❌ Barcha xizmatlar bu raqamlarni qabul qilavermasligi mumkin.

📌 Ushbu raqamni tanlab, siz yuqoridagi holatlarni tushunganingizni va roziligingizni bildirgan bo‘lasiz.
</i></b>
</blockquote>
<b>Davom etishni xohlaysizmi?</b>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode : 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Roziman', callback_data: 'confirm_number' }],
            [{ text: '⬅️ Orqaga', callback_data: 'back_to_main' }]
          ]
        }
      }
    );
  }

  if (data === 'confirm_number') {
    const selected = userSelections.get(`${userId}_selected`);
    if (!selected) {
      return bot.answerCallbackQuery(callbackQuery.id, {
        text: '❌ Raqam topilmadi.'
      });
    }

    const decremented = await decrementReferals(userId, 5);
    if (!decremented) {
      return bot.answerCallbackQuery(callbackQuery.id, {
        text: '🚫 Yetarli referal yo‘q.'
      });
    }

    // SMS olish tugmasi
    return bot.editMessageText(
      `<b>📞 Siz tanlagan raqam: <code>${selected.phone}</code></b>\n<i>👉 Endi “SMS olish” tugmasini bosing.</i>\n\n<u>5 daqiqa ichida xabar kelmasa sizga xabar beramiz..</u>`,
      {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📩 SMS olish', callback_data: 'get_sms_now' }],
            [{ text: '⬅️ Orqaga', callback_data: 'back_to_main' }]
          ]
        }
      }
    );
  }

if (data === 'get_sms_now') {
  const selected = userSelections.get(`${userId}_selected`);
  if (!selected) {
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: '❌ SMS olish uchun raqam tanlanmagan.'
    });
  }

  await bot.answerCallbackQuery(callbackQuery.id, {
    text: '📩 SMS kelishini kuting..'
  });

  const startTime = Date.now();
  const waitTime = 5 * 60 * 1000; 
  const checkInterval = 15 * 1000; 

  async function pollMessages() {
    const result = await fetchMessagesForItem(selected);
    if (result.ok && result.messages.length > 0) {
      // SMS topildi, xabarni yuborish
      let messageText = `📨 Oxirgi ${result.messages.length} ta SMS:\n\n`;
      for (const m of result.messages) {
        messageText += `- ${m.text}\n\n`;
      }
      try {
        await bot.editMessageText(messageText, {
          chat_id: chatId,
          message_id: msg.message_id
        });
      } catch (e) {
        console.error('Xabarni yangilashda xatolik:', e.message);
      }
      return; // Tugatish
    } else {
      // Agar vaqt tugagan bo‘lsa, xabar kelmadi deb yuborish
      if (Date.now() - startTime > waitTime) {
        try {
          await bot.editMessageText('❌ Hech qanday xabar kelmadi.', {
            chat_id: chatId,
            message_id: msg.message_id
          });
        } catch (e) {
          console.error('Xabarni yangilashda xatolik:', e.message);
        }
        return;
      }
      // Aks holda yana 15 sekunddan keyin tekshirish
      setTimeout(pollMessages, checkInterval);
    }
  }

  // Pollingni boshlash
  pollMessages();
}


  return bot.answerCallbackQuery(callbackQuery.id, {
    text: '⚠️ Nomaʼlum buyruq.'
  });
});
