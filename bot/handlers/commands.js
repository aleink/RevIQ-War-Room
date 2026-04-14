'use strict';

const { Composer } = require('grammy');
const db = require('../db');
const ai = require('../ai');
const {
  formatTask,
  formatTasksByAssignee,
  formatDecision,
  chunkText,
  resolveAssignee,
  hoursAgo,
  daysAgo,
  daysOpen,
  formatDate,
  buildTelegramDeepLink,
  prioritySort,
} = require('../utils');

const composer = new Composer();

// ─────────────────────────────────────────────────────────────────────────────
// Helper — get sender name from context
// ─────────────────────────────────────────────────────────────────────────────
async function getSenderName(ctx) {
  const from = ctx.message?.from;
  if (!from) return 'Unknown';

  // Try to match to a team member by Telegram ID first
  const teamName = await db.getTeamMemberName(from.id);
  if (teamName) return teamName;

  // Fall back to first name + last name
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper — send long replies in chunks
// ─────────────────────────────────────────────────────────────────────────────
async function sendChunked(ctx, text, options = {}) {
  const chunks = chunkText(text, 4000);
  for (const chunk of chunks) {
    await ctx.reply(chunk, { parse_mode: 'Markdown', ...options });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// /help
// ─────────────────────────────────────────────────────────────────────────────
composer.command('help', async (ctx) => {
  const help = `*RevIQ Command — Available Commands*

*AI & Search*
/ask [question] — Ask me anything. I'll use recent context to answer.
/find [query] — Search the message history for something specific.

*Tasks*
/todos — Extract all action items from the last 24h of chat.
/todo [task] @[person] — Create a single task and assign it.
/mytasks — See your open tasks, ordered by priority.
/done [task # or description] — Mark a task complete.
/opentasks — All open tasks grouped by person.

*Decisions & Recaps*
/decide [what was decided] — Log a decision and pin it.
/recap — Summary of recent activity (last 24h).
/weeklyrecap — Full 7-day recap with per-person breakdown.

*Message Tagging*
/tag — Reply to any message with this to auto-categorize it.

*Autonomous Mode*
/listen — Turn on autonomous mode (I'll speak up when I spot something).
/silent — Turn off autonomous mode. I'll still listen and respond to commands.

*Daily Nudge*
/dailyon — Enable daily morning summary.
/dailyoff — Disable daily morning summary.`;

  await ctx.reply(help, { parse_mode: 'Markdown' });
});

// ─────────────────────────────────────────────────────────────────────────────
// /ask [question]
// ─────────────────────────────────────────────────────────────────────────────
composer.command('ask', async (ctx) => {
  const question = ctx.message.text.replace(/^\/ask\s*/i, '').trim();
  if (!question) return ctx.reply('What do you want to know? Usage: /ask [question]');

  const [context] = await Promise.all([db.getRecentMessages(30)]);
  const response = await ai.askClaude(question, context);
  if (response) await sendChunked(ctx, response);
});

// ─────────────────────────────────────────────────────────────────────────────
// /find [query]
// ─────────────────────────────────────────────────────────────────────────────
composer.command('find', async (ctx) => {
  const query = ctx.message.text.replace(/^\/find\s*/i, '').trim();
  if (!query) return ctx.reply('Usage: /find [what you\'re looking for]');

  const chatId = ctx.chat.id;

  // Search both text messages and file messages
  const [textResults, fileResults] = await Promise.all([
    db.getRecentMessages(10, query),
    db.getFileMessages(query, 5),
  ]);

  // Merge and deduplicate
  const allResults = [...textResults];
  for (const f of fileResults) {
    if (!allResults.find((m) => m.telegram_message_id === f.telegram_message_id)) {
      allResults.push(f);
    }
  }

  if (!allResults.length) {
    return ctx.reply(`Nothing found for "${query}".`);
  }

  let responseText = `*Found ${allResults.length} result(s) for "${query}":*\n\n`;

  for (const msg of allResults.slice(0, 8)) {
    const link = buildTelegramDeepLink(chatId, msg.telegram_message_id);
    const preview = msg.text ? msg.text.slice(0, 120) + (msg.text.length > 120 ? '…' : '') : `[${msg.file_type || 'file'}]`;
    const date = formatDate(msg.created_at);
    responseText += `• *${msg.sender_name}* · ${date}\n  ${preview}\n  [→ Jump to message](${link})\n\n`;
  }

  await sendChunked(ctx, responseText.trim());

  // Re-send file attachments that were found
  const filesOnly = allResults.filter((m) => m.file_id && m.file_type);
  for (const f of filesOnly.slice(0, 3)) {
    try {
      switch (f.file_type) {
        case 'photo': await ctx.replyWithPhoto(f.file_id); break;
        case 'document': await ctx.replyWithDocument(f.file_id); break;
        case 'voice': await ctx.replyWithVoice(f.file_id); break;
        case 'video': await ctx.replyWithVideo(f.file_id); break;
      }
    } catch (e) {
      console.warn('[commands] Could not resend file:', e.message);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /todos — extract tasks from last 24h
// ─────────────────────────────────────────────────────────────────────────────
composer.command('todos', async (ctx) => {
  const senderName = await getSenderName(ctx);

  const [recent, teamMembers] = await Promise.all([
    db.getMessagesSince(hoursAgo(24)),
    db.getTeamMembers(),
  ]);

  if (recent.length < 2) {
    return ctx.reply('Not enough messages in the last 24h to extract tasks from.');
  }

  const extracted = await ai.extractTasks(recent, teamMembers);
  if (!extracted.length) {
    return ctx.reply('No clear action items found in the last 24h of chat.');
  }

  // Save all tasks to Supabase
  const taskRows = extracted.map((t) => ({
    title: t.title,
    assigned_to: t.assigned_to || 'Unassigned',
    priority: ['high', 'normal', 'low'].includes(t.priority) ? t.priority : 'normal',
    status: 'open',
    created_by: senderName,
  }));

  const created = await db.createTasks(taskRows);

  let reply = `*Extracted ${created.length} task(s) from the last 24h:*\n\n`;
  created.forEach((t, i) => {
    reply += formatTask(t, i + 1) + '\n';
  });
  reply += `\n_Use /opentasks to see everything or /done [#] to mark complete._`;

  await sendChunked(ctx, reply);
});

// ─────────────────────────────────────────────────────────────────────────────
// /todo [description] @[person]
// ─────────────────────────────────────────────────────────────────────────────
composer.command('todo', async (ctx) => {
  const rawText = ctx.message.text.replace(/^\/todo\s*/i, '').trim();
  if (!rawText) return ctx.reply('Usage: /todo [description] @[person]');

  const senderName = await getSenderName(ctx);
  const teamMembers = await db.getTeamMembers();

  // Extract @mention and assignee
  const mentionMatch = rawText.match(/@(\w+)/);
  const assignee = mentionMatch ? resolveAssignee(mentionMatch[1], teamMembers) : senderName;
  const title = rawText.replace(/@\w+/g, '').trim();

  const task = await db.createTask({
    title,
    assigned_to: assignee,
    created_by: senderName,
    source_message_id: ctx.message.message_id,
  });

  if (!task) return ctx.reply('Failed to create task. Check the logs.');

  await ctx.reply(`✅ Task created:\n${formatTask(task)}`, { parse_mode: 'Markdown' });
});

// ─────────────────────────────────────────────────────────────────────────────
// /mytasks
// ─────────────────────────────────────────────────────────────────────────────
composer.command('mytasks', async (ctx) => {
  const senderName = await getSenderName(ctx);
  const tasks = await db.getUserTasks(senderName);
  const sorted = prioritySort(tasks);

  if (!sorted.length) {
    return ctx.reply(`No open tasks for ${senderName}. 🎉`);
  }

  let reply = `*Your open tasks, ${senderName}:*\n\n`;
  sorted.forEach((t, i) => { reply += formatTask(t, i + 1) + '\n'; });
  await sendChunked(ctx, reply);
});

// ─────────────────────────────────────────────────────────────────────────────
// /done [task number or description]
// ─────────────────────────────────────────────────────────────────────────────
composer.command('done', async (ctx) => {
  const input = ctx.message.text.replace(/^\/done\s*/i, '').trim();
  if (!input) return ctx.reply('Usage: /done [task # or description]');

  const senderName = await getSenderName(ctx);

  // If input is a number, get that task from user's open tasks
  if (/^\d+$/.test(input)) {
    const tasks = prioritySort(await db.getUserTasks(senderName));
    const index = parseInt(input, 10) - 1;
    if (index < 0 || index >= tasks.length) {
      return ctx.reply(`No task #${input} found. Use /mytasks to see your list.`);
    }
    const task = tasks[index];
    const updated = await db.updateTaskStatus(task.id, 'done');
    if (updated) {
      return ctx.reply(`✅ Done: *${updated.title}*\nCompleted ${formatDate(updated.completed_at)}`, { parse_mode: 'Markdown' });
    }
    return ctx.reply('Failed to mark task done.');
  }

  // Text-based search
  const matches = await db.findTaskByTitle(input);
  if (!matches.length) {
    return ctx.reply(`No open task found matching "${input}".`);
  }

  const task = matches[0]; // take the best match
  const updated = await db.updateTaskStatus(task.id, 'done');
  if (updated) {
    await ctx.reply(`✅ Done: *${updated.title}*\nCompleted ${formatDate(updated.completed_at)}`, { parse_mode: 'Markdown' });
  } else {
    await ctx.reply('Failed to update task.');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /opentasks
// ─────────────────────────────────────────────────────────────────────────────
composer.command('opentasks', async (ctx) => {
  const tasks = await db.getAllOpenTasks();
  const reply = formatTasksByAssignee(tasks);
  await sendChunked(ctx, `*All Open Tasks*\n\n${reply}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// /decide [decision text]
// ─────────────────────────────────────────────────────────────────────────────
composer.command('decide', async (ctx) => {
  const decisionText = ctx.message.text.replace(/^\/decide\s*/i, '').trim();
  if (!decisionText) return ctx.reply('Usage: /decide [what was decided]');

  const senderName = await getSenderName(ctx);

  const decision = await db.createDecision({
    decision: decisionText,
    decided_by: senderName,
    source_message_id: ctx.message.message_id,
  });

  if (!decision) return ctx.reply('Failed to log decision. Check the logs.');

  const confirmMsg = await ctx.reply(
    `📌 *Decision logged:*\n"${decisionText}"\n— ${senderName}`,
    { parse_mode: 'Markdown' }
  );

  // Pin the confirmation message in the group
  try {
    await ctx.api.pinChatMessage(ctx.chat.id, confirmMsg.message_id, {
      disable_notification: true,
    });
  } catch (e) {
    // Bot may not have pin permissions — non-fatal
    console.warn('[commands] Could not pin decision message:', e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /recap
// ─────────────────────────────────────────────────────────────────────────────
composer.command('recap', async (ctx) => {
  const [messages, allTasks, decisions] = await Promise.all([
    db.getMessagesSince(hoursAgo(24)),
    db.getAllOpenTasks(),
    db.getRecentDecisions(10),
  ]);

  const summary = await ai.generateRecap(messages, allTasks, decisions, '24 hours');
  if (summary) await sendChunked(ctx, `*Recap — Last 24 Hours*\n\n${summary}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// /weeklyrecap
// ─────────────────────────────────────────────────────────────────────────────
composer.command('weeklyrecap', async (ctx) => {
  const [messages, allTasks, decisions, teamMembers] = await Promise.all([
    db.getMessagesSince(daysAgo(7)),
    db.getAllOpenTasks(),
    db.getRecentDecisions(30),
    db.getTeamMembers(),
  ]);

  const summary = await ai.generateWeeklyRecap(messages, allTasks, decisions, teamMembers);
  if (summary) await sendChunked(ctx, `*Weekly Recap*\n\n${summary}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// /tag — reply to a message to categorize it
// ─────────────────────────────────────────────────────────────────────────────
composer.command('tag', async (ctx) => {
  const replyTo = ctx.message?.reply_to_message;
  if (!replyTo) {
    return ctx.reply('Use /tag as a reply to the message you want to categorize.');
  }

  const text = replyTo.text || replyTo.caption || '';
  if (!text) return ctx.reply('No text content found on that message to categorize.');

  const tag = await ai.categorizeMessage(text);
  await db.tagMessage(replyTo.message_id, [tag]);

  await ctx.reply(`Tagged as ${tag}`, { reply_to_message_id: replyTo.message_id });
});

// ─────────────────────────────────────────────────────────────────────────────
// /silent and /listen — autonomous mode toggle
// (State is managed in the runtime object passed from index.js)
// ─────────────────────────────────────────────────────────────────────────────
composer.command('silent', async (ctx) => {
  // Signal autonomous module to disable — uses a shared state object on the bot instance
  if (ctx.bot?.autonomousState) {
    ctx.bot.autonomousState.enabled = false;
  }
  await ctx.reply("Got it. I'll stay quiet unless you tag me or use a command.");
});

composer.command('listen', async (ctx) => {
  if (ctx.bot?.autonomousState) {
    ctx.bot.autonomousState.enabled = true;
  }
  await ctx.reply("⚡ Autonomous mode on. I'll speak up when I spot something worth flagging.");
});

// ─────────────────────────────────────────────────────────────────────────────
// /dailyon and /dailyoff
// ─────────────────────────────────────────────────────────────────────────────
composer.command('dailyon', async (ctx) => {
  if (ctx.bot?.autonomousState) {
    ctx.bot.autonomousState.dailyEnabled = true;
  }
  await ctx.reply('Daily morning summary enabled. Good morning messages incoming.');
});

composer.command('dailyoff', async (ctx) => {
  if (ctx.bot?.autonomousState) {
    ctx.bot.autonomousState.dailyEnabled = false;
  }
  await ctx.reply('Daily morning summary disabled.');
});

module.exports = composer;
