'use strict';

require('dotenv').config();

const { Bot, webhookCallback } = require('grammy');
const express = require('express');
const cron = require('node-cron');
const db = require('./db');
const commands = require('./handlers/commands');
const mentions = require('./handlers/mentions');
const { AutonomousState, setupAutonomous, onMessage, checkStaleTasks, sendDailyNudge } = require('./handlers/autonomous');

// ─────────────────────────────────────────────────────────────────────────────
// Validate required environment variables
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_ENV = [
  'TELEGRAM_BOT_TOKEN',
  'TEAM_CHAT_ID',
  'ANTHROPIC_API_KEY',
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

// Attach autonomous state to the bot instance so handlers can access it via ctx.bot
const autonomousState = new AutonomousState();
bot.autonomousState = autonomousState;

// ─────────────────────────────────────────────────────────────────────────────
// Middleware — make autonomousState available in ctx for command handlers
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  ctx.bot = bot;
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Message logging middleware — store every group message in Supabase
// This runs before all handlers so we never miss a message
// ─────────────────────────────────────────────────────────────────────────────

bot.on('message', async (ctx, next) => {
  const msg = ctx.message;
  if (!msg) return next();

  // Only process messages from the configured group chat
  if (String(ctx.chat?.id) !== String(CHAT_ID)) return next();

  try {
    const from = msg.from || {};
    const senderName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown';

    // Detect file type
    let file_type = null;
    let file_id = null;

    if (msg.photo?.length) {
      file_type = 'photo';
      file_id = msg.photo[msg.photo.length - 1]?.file_id; // largest size
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

  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Register handlers
// ─────────────────────────────────────────────────────────────────────────────

bot.use(commands);
bot.use(mentions);

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
  console.log('[bot] Fetching missed messages from Telegram...');
  try {
    // getUpdates returns a max of 100 pending updates
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
  // Stale task check — runs daily at 10:00 AM
  cron.schedule('0 10 * * *', async () => {
    console.log('[cron] Running stale task check...');
    await checkStaleTasks(bot, CHAT_ID);
  });

  // Daily morning nudge
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
// Launch — webhook (production) or long polling (development)
// ─────────────────────────────────────────────────────────────────────────────

async function launch() {
  await catchUpMessages();
  setupAutonomous(bot, autonomousState, CHAT_ID);
  setupCronJobs();

  if (IS_PRODUCTION && WEBHOOK_URL) {
    // ── Webhook mode ──────────────────────────────────────────────────────────
    const app = express();
    app.use(express.json());

    // Health check endpoint (used by Railway + Docker healthcheck)
    app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

    // Telegram will POST updates here
    const webhookPath = '/telegram-webhook';
    app.post(webhookPath, webhookCallback(bot, 'express'));

    app.listen(PORT, async () => {
      console.log(`[bot] Express server listening on port ${PORT}`);

      const fullWebhookUrl = `${WEBHOOK_URL}${webhookPath}`;
      try {
        await bot.api.setWebhook(fullWebhookUrl);
        console.log(`[bot] Webhook registered: ${fullWebhookUrl}`);
      } catch (err) {
        console.error('[bot] Failed to set webhook:', err.message);
      }

      console.log('[bot] RevIQ Command is live 🚀');
    });
  } else {
    // ── Long polling mode (local development) ────────────────────────────────
    console.log('[bot] Starting in long polling mode (development)');

    // Make sure no stale webhook is registered
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
