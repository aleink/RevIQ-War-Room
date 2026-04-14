'use strict';

require('dotenv').config();

const { Bot, webhookCallback } = require('grammy');
const express = require('express');
const cron = require('node-cron');
const db = require('./db');
const ai = require('./ai');
const { chunkText } = require('./utils');
const commands = require('./handlers/commands');
const { AutonomousState, setupAutonomous, onMessage, checkStaleTasks, sendDailyNudge } = require('./handlers/autonomous');

// ─────────────────────────────────────────────────────────────────────────────
// Validate required environment variables
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_ENV = [
  'TELEGRAM_BOT_TOKEN',
  'TEAM_CHAT_ID',
  'GEMINI_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[bot] Missing required env var: ${key}`);
    process.exit(1);
  }
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TEAM_CHAT_ID;
const PORT = parseInt(process.env.PORT || '3000', 10);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const WEBHOOK_URL = process.env.RAILWAY_STATIC_URL || process.env.WEBHOOK_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Initialize bot
// ─────────────────────────────────────────────────────────────────────────────

const bot = new Bot(BOT_TOKEN);

// Cache bot info at module level so mention detection works reliably
let BOT_USERNAME = null;
let BOT_ID = null;

// Attach autonomous state to the bot instance so handlers can access it via ctx.bot
const autonomousState = new AutonomousState();
bot.autonomousState = autonomousState;

// ─────────────────────────────────────────────────────────────────────────────
// Global middleware — inject bot reference + log every message + detect mentions
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  ctx.bot = bot;

  const msg = ctx.message;
  if (!msg) return next();

  // ── RAW DEBUG — uncomment for troubleshooting ──────────────────────────
  // console.log(`[raw] chat=${ctx.chat?.id} text="${(msg.text||'').slice(0,60)}" match=${String(ctx.chat?.id) === String(CHAT_ID)}`);

  // Only process messages from the configured group chat
  if (String(ctx.chat?.id) !== String(CHAT_ID)) return next();

  // ── Store every message in Supabase ────────────────────────────────────
  try {
    const from = msg.from || {};
    const senderName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown';

    // Detect file type
    let file_type = null;
    let file_id = null;

    if (msg.photo?.length) {
      file_type = 'photo';
      file_id = msg.photo[msg.photo.length - 1]?.file_id;
    } else if (msg.document) {
      file_type = 'document';
      file_id = msg.document.file_id;
    } else if (msg.voice) {
      file_type = 'voice';
      file_id = msg.voice.file_id;
    } else if (msg.video) {
      file_type = 'video';
      file_id = msg.video.file_id;
    }

    await db.saveMessage({
      telegram_message_id: msg.message_id,
      sender_name: senderName,
      sender_telegram_id: from.id,
      text: msg.text || msg.caption || null,
      file_type,
      file_id,
      reply_to_message_id: msg.reply_to_message?.message_id || null,
      created_at: new Date(msg.date * 1000).toISOString(),
    });

    // Notify autonomous handler
    const autonomousHook = onMessage(bot, autonomousState, CHAT_ID);
    await autonomousHook();
  } catch (err) {
    console.error('[bot] Message logging error:', err.message);
  }

  // ── Detect @mention or direct reply to bot ─────────────────────────────
  // If this is a command, skip — let the commands handler deal with it
  const text = msg.text || msg.caption || '';
  const isCommand = text.startsWith('/');

  if (!isCommand && BOT_USERNAME) {
    const isMentioned = text.includes(`@${BOT_USERNAME}`);
    const isReplyToBot = msg.reply_to_message?.from?.id === BOT_ID;

    if (isMentioned || isReplyToBot) {
        // This IS a mention/reply — handle it directly, don't pass to next()
        const question = text
          .replace(new RegExp(`@${BOT_USERNAME}`, 'gi'), '')
          .trim();

        if (!question) {
          await ctx.reply("You tagged me — what do you need?", {
            reply_to_message_id: msg.message_id,
          });
          return; // consumed — don't call next()
        }

        console.log(`[mentions] @${BOT_USERNAME} tagged by ${msg.from?.first_name}: "${question}"`);

        try {
          const context = await db.getRecentMessages(30);
          const response = await ai.askGemini(question, context);

          if (response) {
            const chunks = chunkText(response, 4000);
            for (const chunk of chunks) {
              await ctx.reply(chunk, {
                parse_mode: 'Markdown',
                reply_to_message_id: msg.message_id,
              });
            }
          }
        } catch (err) {
          console.error('[mentions] Error:', err.message);
          await ctx.reply("Something went wrong on my end. Try again.", {
            reply_to_message_id: msg.message_id,
          });
        }

        return; // consumed — don't pass to commands
    }
  }

  return next(); // pass to commands handler
});

// ─────────────────────────────────────────────────────────────────────────────
// Register command handlers
// ─────────────────────────────────────────────────────────────────────────────

bot.use(commands);

// ─────────────────────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────────────────────

bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`[bot] Error handling update ${ctx?.update?.update_id}:`, err.error);
});

// ─────────────────────────────────────────────────────────────────────────────
// Startup catch-up — fetch missed messages from Telegram
// ─────────────────────────────────────────────────────────────────────────────

async function catchUpMessages() {
  if (IS_PRODUCTION && WEBHOOK_URL) return; // Webhooks do not support getUpdates

  console.log('[bot] Fetching missed messages from Telegram...');
  try {
    const updates = await bot.api.getUpdates({ limit: 100 });

    let saved = 0;
    for (const update of updates) {
      const msg = update.message;
      if (!msg || String(msg.chat?.id) !== String(CHAT_ID)) continue;

      const from = msg.from || {};
      const senderName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown';

      let file_type = null;
      let file_id = null;
      if (msg.photo?.length) { file_type = 'photo'; file_id = msg.photo[msg.photo.length - 1]?.file_id; }
      else if (msg.document) { file_type = 'document'; file_id = msg.document.file_id; }
      else if (msg.voice) { file_type = 'voice'; file_id = msg.voice.file_id; }
      else if (msg.video) { file_type = 'video'; file_id = msg.video.file_id; }

      await db.saveMessage({
        telegram_message_id: msg.message_id,
        sender_name: senderName,
        sender_telegram_id: from.id,
        text: msg.text || msg.caption || null,
        file_type,
        file_id,
        reply_to_message_id: msg.reply_to_message?.message_id || null,
        created_at: new Date(msg.date * 1000).toISOString(),
      });
      saved++;
    }

    if (saved > 0) {
      console.log(`[bot] Stored ${saved} missed message(s) from catch-up`);
    } else {
      console.log('[bot] No missed messages found');
    }
  } catch (err) {
    console.warn('[bot] Catch-up failed (non-fatal):', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron jobs — stale task nudges + daily morning message
// ─────────────────────────────────────────────────────────────────────────────

function setupCronJobs() {
  cron.schedule('0 10 * * *', async () => {
    console.log('[cron] Running stale task check...');
    await checkStaleTasks(bot, CHAT_ID);
  });

  const dailyTime = process.env.DAILY_RECAP_TIME || '09:00';
  const [hour, minute] = dailyTime.split(':');
  cron.schedule(`${minute || '0'} ${hour || '9'} * * *`, async () => {
    if (autonomousState.dailyEnabled) {
      console.log('[cron] Sending daily morning nudge...');
      await sendDailyNudge(bot, CHAT_ID);
    }
  });

  console.log(`[bot] Cron jobs registered (daily recap at ${dailyTime})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Register Telegram command menu (shows commands when user types "/")
// ─────────────────────────────────────────────────────────────────────────────

async function registerCommandMenu() {
  const commandList = [
    { command: 'ask',         description: 'Ask a question — I\'ll use recent context' },
    { command: 'find',        description: 'Search the message history' },
    { command: 'todos',       description: 'Extract action items from the last 24h' },
    { command: 'todo',        description: 'Create a task: /todo [task] @[person]' },
    { command: 'mytasks',     description: 'See your open tasks by priority' },
    { command: 'done',        description: 'Mark a task complete' },
    { command: 'opentasks',   description: 'All open tasks grouped by person' },
    { command: 'decide',      description: 'Log a decision and pin it' },
    { command: 'recap',       description: 'Summary of the last 24 hours' },
    { command: 'weeklyrecap', description: 'Structured 7-day recap' },
    { command: 'tag',         description: 'Reply to a message to categorize it' },
    { command: 'listen',      description: 'Turn on autonomous mode' },
    { command: 'silent',      description: 'Turn off autonomous mode' },
    { command: 'dailyon',     description: 'Enable daily morning summary' },
    { command: 'dailyoff',    description: 'Disable daily morning summary' },
    { command: 'help',        description: 'Show all available commands' },
  ];

  try {
    // Register for default scope (private chats)
    await bot.api.setMyCommands(commandList);
    // Register for group chats specifically
    await bot.api.setMyCommands(commandList, {
      scope: { type: 'all_group_chats' },
    });
    // Register for this specific group chat
    await bot.api.setMyCommands(commandList, {
      scope: { type: 'all_chat_administrators' },
    });
    console.log('[bot] Command menu registered for all scopes');
  } catch (err) {
    console.warn('[bot] Failed to register command menu:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Launch — webhook (production) or long polling (development)
// ─────────────────────────────────────────────────────────────────────────────

async function launch() {
  // Initialize bot info FIRST — populates ctx.me and caches username/id
  await bot.init();
  BOT_USERNAME = bot.botInfo.username;
  BOT_ID = bot.botInfo.id;
  console.log(`[bot] Initialized as @${BOT_USERNAME} (ID: ${BOT_ID})`);

  await catchUpMessages();
  await registerCommandMenu();
  setupAutonomous(bot, autonomousState, CHAT_ID);
  setupCronJobs();

  if (IS_PRODUCTION && WEBHOOK_URL) {
    const app = express();
    app.use(express.json());

    app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

    const webhookPath = '/telegram-webhook';
    app.post(webhookPath, webhookCallback(bot, 'express'));

    app.listen(PORT, '0.0.0.0', async () => {
      console.log(`[bot] Express server listening on port ${PORT}`);

      const safeWebhookUrl = WEBHOOK_URL.startsWith('http') ? WEBHOOK_URL : `https://${WEBHOOK_URL}`;
      const fullWebhookUrl = `${safeWebhookUrl}${webhookPath}`;
      try {
        await bot.api.setWebhook(fullWebhookUrl);
        console.log(`[bot] Webhook registered: ${fullWebhookUrl}`);
      } catch (err) {
        console.error('[bot] Failed to set webhook:', err.message);
      }

      console.log('[bot] RevIQ Command is live 🚀');
    });
  } else {
    console.log('[bot] Starting in long polling mode (development)');

    try {
      await bot.api.deleteWebhook();
    } catch (_) {
      // ignore
    }

    await bot.start({
      onStart: () => console.log('[bot] RevIQ Command is live 🚀 (long polling)'),
    });
  }
}

launch().catch((err) => {
  console.error('[bot] Fatal startup error:', err);
  process.exit(1);
});
