require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const express = require('express');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error('❌ Ошибка: Не указан BOT_TOKEN в файле .env или переменных окружения!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Хранилище отслеживаемых сервисов
// { url: { url, intervalMinutes, timerId, chatId, status, lastCheck } }
const services = new Map();

// Состояния пользователя для ввода данных (waiting_for_url / waiting_for_interval)
const userStates = new Map();

// --- СЕРВЕР ДЛЯ РЕНДЕРА (Чтобы не засыпал) ---
const app = express();
app.get('/', (req, res) => res.send('🚀 Ping Bot is active and running!'));
app.listen(PORT, () => console.log(`🌐 Web Server running on port ${PORT}`));

// --- ФУНКЦИИ ПИНГА И МОНИТОРИНГА ---

async function pingService(url, chatId) {
  const service = services.get(url);
  if (!service) return;

  const startTime = Date.now();
  try {
    const res = await axios.get(url, { 
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const responseTime = Date.now() - startTime;
    
    services.set(url, {
      ...service,
      status: `🟢 200 OK (${responseTime}ms)`,
      lastCheck: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    });
  } catch (err) {
    const statusCode = err.response ? `HTTP ${err.response.status}` : 'No Response';
    
    services.set(url, {
      ...service,
      status: `🔴 Fail (${statusCode})`,
      lastCheck: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    });

    // Отправляем алерт при падении
    bot.telegram.sendMessage(
      chatId,
      `🚨 *СЕРВИС НЕ ОТВЕЧАЕТ!*\n\n🔗 *URL:* ${url}\n❌ *Ошибка:* ${statusCode} / ${err.message}\n⏰ *Время:* ${new Date().toLocaleTimeString('ru-RU')}`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }
}

function startTimer(url, minutes, chatId) {
  const existing = services.get(url);
  if (existing && existing.timerId) {
    clearInterval(existing.timerId);
  }

  // Запускаем первый пинг сразу
  pingService(url, chatId);

  // Интервал в миллисекундах
  const timerId = setInterval(() => {
    pingService(url, chatId);
  }, minutes * 60 * 1000);

  services.set(url, {
    url,
    intervalMinutes: minutes,
    timerId,
    chatId,
    status: '⏳ Проверяется...',
    lastCheck: 'Только что'
  });
}

function stopTimer(url) {
  const service = services.get(url);
  if (service && service.timerId) {
    clearInterval(service.timerId);
  }
  services.delete(url);
}

// --- КНОПКИ И ИНТЕРФЕЙС ---

function getMainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📊 Мои сервисы', 'list_services')],
    [Markup.button.callback('➕ Добавить сервис', 'add_service'), Markup.button.callback('⚡ Пинг всех', 'ping_now')],
    [Markup.button.callback('ℹ️ Инфо и Помощь', 'help_info')]
  ]);
}

// --- ОБРАБОТЧИКИ КОМАНД И КНОПОК ---

bot.start((ctx) => {
  ctx.reply(
    `👋 *Привет! Я бот-пингер для Render и любых сайтов.*\n\n` +
    `Я могу регулярно проверять доступность ваших веб-сервисов и присылать предупреждения, если сервис упадет.`,
    { parse_mode: 'Markdown', ...getMainMenu() }
  );
});

// Главное меню
bot.action('main_menu', (ctx) => {
  userStates.delete(ctx.from.id);
  ctx.editMessageText('🛠 *Главное меню:*', { parse_mode: 'Markdown', ...getMainMenu() });
});

// Информация
bot.action('help_info', (ctx) => {
  ctx.editMessageText(
    `ℹ️ *Информация*\n\n` +
    `• Добавляйте ссылки на Render, Vercel, VPS или обычные сайты.\n` +
    `• Указывайте дефолтный таймер (например 5-10 мин) или свой кастомный.\n` +
    `• Если сервис выдаст ошибку или перестанет отвечать, бот пришлет алерт.\n\n` +
    `💡 *Чтобы бот на Render не засыпал*, зарегистрируйте URL созданного бота в бесплатных сервисах вроде UptimeRobot (каждые 10 мин).`,
    { 
      parse_mode: 'Markdown', 
      ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'main_menu')]]) 
    }
  );
});

// Список сервисов
bot.action('list_services', (ctx) => {
  if (services.size === 0) {
    return ctx.editMessageText(
      '📭 У вас пока нет отслеживаемых сервисов.', 
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ Добавить сервис', 'add_service')],
        [Markup.button.callback('🔙 Назад', 'main_menu')]
      ])
    );
  }

  let messageText = '📋 *Ваши отслеживаемые сервисы:*\n\n';
  const buttons = [];

  services.forEach((val, url) => {
    messageText += `${val.status}\n🔗 ${url}\n⏱ Интервал: *${val.intervalMinutes} мин.* | Проверка: *${val.lastCheck}*\n\n`;
    
    // Кнопка управления для каждого сервиса
    let domain = url;
    try { domain = new URL(url).hostname; } catch (e) {}
    buttons.push([Markup.button.callback(`⚙️ ${domain}`, `manage_${url}`)]);
  });

  buttons.push([Markup.button.callback('🔙 Назад в меню', 'main_menu')]);

  ctx.editMessageText(messageText, { 
    parse_mode: 'Markdown', 
    disable_web_page_preview: true,
    ...Markup.inlineKeyboard(buttons) 
  });
});

// Принудительный пинг всех сервисов
bot.action('ping_now', async (ctx) => {
  if (services.size === 0) {
    return ctx.answerCbQuery('У вас нет добавленных сервисов!');
  }
  ctx.answerCbQuery('Запускаю проверку всех сайтов...');
  
  for (const [url, item] of services.entries()) {
    await pingService(url, item.chatId);
  }
  
  ctx.reply('✅ Проверка всех сервисов завершена!', getMainMenu());
});

// Запрос ввода URL
bot.action('add_service', (ctx) => {
  userStates.set(ctx.from.id, { step: 'waiting_for_url' });
  ctx.editMessageText(
    '✍️ *Отправьте ссылку (URL) на сервис, который нужно мониторить:*\n\n' +
    'Пример: `https://my-app.onrender.com` или `https://google.com`',
    { 
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'main_menu')]])
    }
  );
});

// Меню управления конкретным сервисом
bot.action(/^manage_(.+)$/, (ctx) => {
  const url = ctx.match[1];
  const service = services.get(url);

  if (!service) {
    return ctx.answerCbQuery('Сервис не найден');
  }

  const text = `⚙️ *Управление сервисом:*\n\n🔗 *URL:* ${url}\n📊 *Статус:* ${service.status}\n⏱ *Таймер:* ${service.intervalMinutes} мин.`;
  
  const buttons = [
    [Markup.button.callback('⏱ Изменить интервал', `change_time_${url}`)],
    [Markup.button.callback('🗑 Удалить', `delete_${url}`)],
    [Markup.button.callback('🔙 К списку сервисов', 'list_services')]
  ];

  ctx.editMessageText(text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...Markup.inlineKeyboard(buttons) });
});

// Выбор нового интервала кнопками
bot.action(/^change_time_(.+)$/, (ctx) => {
  const url = ctx.match[1];
  
  const buttons = [
    [
      Markup.button.callback('1 мин', `set_int_${url}_1`),
      Markup.button.callback('5 мин', `set_int_${url}_5`),
      Markup.button.callback('10 мин', `set_int_${url}_10`),
      Markup.button.callback('15 мин', `set_int_${url}_15`)
    ],
    [Markup.button.callback('🔙 Назад', `manage_${url}`)]
  ];

  ctx.editMessageText(`⏱ Выберите новый интервал проверки для:\n\`${url}\``, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
});

// Применение нового интервала
bot.action(/^set_int_(.+)_(\d+)$/, (ctx) => {
  const url = ctx.match[1];
  const minutes = parseInt(ctx.match[2]);

  startTimer(url, minutes, ctx.chat.id);
  ctx.answerCbQuery(`Интервал изменен на ${minutes} мин.`);
  
  // Возвращаем в меню управления
  const service = services.get(url);
  const text = `⚙️ *Управление сервисом:*\n\n🔗 *URL:* ${url}\n📊 *Статус:* ${service.status}\n⏱ *Таймер:* ${service.intervalMinutes} мин.`;
  const buttons = [
    [Markup.button.callback('⏱ Изменить интервал', `change_time_${url}`)],
    [Markup.button.callback('🗑 Удалить', `delete_${url}`)],
    [Markup.button.callback('🔙 К списку сервисов', 'list_services')]
  ];

  ctx.editMessageText(`✅ Интервал успешно изменен на *${minutes} мин.*\n\n` + text, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...Markup.inlineKeyboard(buttons)
  });
});

// Удаление сервиса
bot.action(/^delete_(.+)$/, (ctx) => {
  const url = ctx.match[1];
  stopTimer(url);
  ctx.answerCbQuery('Сервис удален!');
  
  ctx.editMessageText(`🗑 Сервис \`${url}\` удален из мониторинга.`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('🔙 К списку сервисов', 'list_services')]])
  });
});

// Обработка текстовых сообщений (ввод ссылки)
bot.on('text', (ctx) => {
  const state = userStates.get(ctx.from.id);

  if (state && state.step === 'waiting_for_url') {
    let url = ctx.message.text.trim();

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    try {
      new URL(url);
    } catch (e) {
      return ctx.reply('⚠️ Неверный формат ссылки! Попробуйте еще раз или нажмите Отмена.');
    }

    // Запускаем со стандартным интервалом 5 минут
    startTimer(url, 5, ctx.chat.id);
    userStates.delete(ctx.from.id);

    return ctx.reply(
      `✅ *Сервис успешно добавлен!*\n\n🔗 *URL:* ${url}\n⏱ *Дефолтный интервал:* 5 минут (можно изменить в настройках).`,
      { parse_mode: 'Markdown', ...getMainMenu() }
    );
  }

  // Если текст отправлен просто так
  ctx.reply('Используйте кнопки меню для управления ботом:', getMainMenu());
});

bot.launch();
console.log('🤖 Bot successfully started!');

// Грациозное завершение работы
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
    
