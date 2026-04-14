'use strict';

const { Composer } = require('grammy');
const db = require('../db');
const ai = require('../ai');
const { chunkText } = require('../utils');

const composer = new Composer();

// ─────────────────────────────────────────────────────────────────────────────
// Handle @mentions and direct replies to the bot
// This fires when someone tags @botname or replies directly to the bot's message
// Commands (/...) are excluded — those are handled in commands.js
// ─────────────────────────────────────────────────────────────────────────────

composer.on('message', async (ctx) => {
  const msg = ctx.message;
  const botUsername = ctx.me?.username;

  // Only catch @mentions and direct replies — not commands
  if (!msg || !botUsername) return;

  const isCommand = msg.text?.startsWith('/');
  if (isCommand) return;

  const isMentioned = msg.text?.includes(`@${botUsername}`);
  const isReplyToBot = msg.reply_to_message?.from?.username === botUsername;

  if (!isMentioned && !isReplyToBot) return;

  // Build the question — strip the @mention if present
  const question = (msg.text || msg.caption || '')
    .replace(new RegExp(`@${botUsername}`, 'gi'), '')
    .trim();

  if (!question) {
    return ctx.reply("You tagged me — what do you need?", {
      reply_to_message_id: msg.message_id,
    });
  }

  // Pull context and ask Claude
  const context = await db.getRecentMessages(30);
  const response = await ai.askClaude(question, context);

  if (response) {
    const chunks = chunkText(response, 4000);
    for (const chunk of chunks) {
      await ctx.reply(chunk, {
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id,
      });
    }
  }
});

module.exports = composer;
