'use strict';

const db = require('../db');
const ai = require('../ai');

// ─────────────────────────────────────────────────────────────────────────────
// Autonomous Mode — evaluation loop
//
// This module exports:
//   - AutonomousState class (singleton, shared with index.js)
//   - setupAutonomous(bot, state) — starts timers and hooks
//   - onMessage(msg, state) — called for every stored message
// ─────────────────────────────────────────────────────────────────────────────

const MESSAGE_INTERVAL = parseInt(process.env.AUTONOMOUS_MESSAGE_INTERVAL || '10', 10);
const TIME_INTERVAL_MIN = parseInt(process.env.AUTONOMOUS_TIME_INTERVAL || '30', 10);
const DAILY_LIMIT = parseInt(process.env.AUTONOMOUS_DAILY_LIMIT || '3', 10);
const FAST_EXCHANGE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
const FAST_EXCHANGE_THRESHOLD = 5;              // 5+ msgs in 2 min = skip

class AutonomousState {
  constructor() {
    this.enabled = process.env.AUTONOMOUS_MODE === 'on';
    this.dailyEnabled = process.env.DAILY_RECAP_ENABLED === 'true';
    this.messagesSinceLastCheck = 0;
    this.dailyInterventions = 0;
    this.dailyReset = new Date().toDateString();
    this.recentTimestamps = []; // rolling window for fast-exchange detection
    this.lastCheckAt = Date.now();
  }

  resetDailyCountIfNeeded() {
    const today = new Date().toDateString();
    if (today !== this.dailyReset) {
      this.dailyInterventions = 0;
      this.dailyReset = today;
    }
  }

  recordMessage() {
    this.messagesSinceLastCheck++;
    const now = Date.now();
    this.recentTimestamps.push(now);
    // Clean up timestamps older than the fast-exchange window
    this.recentTimestamps = this.recentTimestamps.filter(
      (t) => now - t < FAST_EXCHANGE_WINDOW_MS
    );
  }

  isFastExchange() {
    return this.recentTimestamps.length >= FAST_EXCHANGE_THRESHOLD;
  }

  isDailyLimitReached() {
    this.resetDailyCountIfNeeded();
    return this.dailyInterventions >= DAILY_LIMIT;
  }

  shouldCheckByCount() {
    return this.messagesSinceLastCheck >= MESSAGE_INTERVAL;
  }

  shouldCheckByTime() {
    const elapsed = (Date.now() - this.lastCheckAt) / 1000 / 60;
    return elapsed >= TIME_INTERVAL_MIN;
  }

  resetChecks() {
    this.messagesSinceLastCheck = 0;
    this.lastCheckAt = Date.now();
  }

  recordIntervention() {
    this.dailyInterventions++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core evaluation — runs when triggered by count or time
// ─────────────────────────────────────────────────────────────────────────────

async function runEvaluation(bot, state, chatId) {
  if (!state.enabled) return;
  if (state.isDailyLimitReached()) return;
  if (state.isFastExchange()) {
    console.log('[autonomous] Fast exchange detected — skipping evaluation');
    return;
  }

  state.resetChecks();

  try {
    const [recentMessages, openTasks, recentDecisions] = await Promise.all([
      db.getRecentMessages(20),
      db.getAllOpenTasks(),
      db.getRecentDecisions(10),
    ]);

    if (recentMessages.length < 3) return; // Not enough context

    const response = await ai.evaluateAutonomous(recentMessages, openTasks, recentDecisions);

    if (!response || response.trim() === 'SILENT') {
      console.log('[autonomous] Evaluation result: SILENT');
      return;
    }

    // Extract trigger reason from [LABEL] prefix
    const triggerMatch = response.match(/^\[([A-Z_]+)\]/);
    const triggerReason = triggerMatch ? triggerMatch[1] : 'INTERVENTION';
    const messageBody = response.replace(/^\[[A-Z_]+\]\s*/, '');

    // Format the autonomous message
    const finalMessage = `⚡ ${messageBody}`;

    // Send to group
    await bot.api.sendMessage(chatId, finalMessage, { parse_mode: 'Markdown' });

    // Log to Supabase
    await db.logIntervention(triggerReason, finalMessage);

    state.recordIntervention();
    console.log(`[autonomous] Intervened — reason: ${triggerReason}`);
  } catch (err) {
    console.error('[autonomous] Evaluation error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Called for every message the bot receives in the group
// ─────────────────────────────────────────────────────────────────────────────

function onMessage(bot, state, chatId) {
  return async () => {
    if (!state.enabled) return;

    state.recordMessage();

    // Check by message count threshold
    if (state.shouldCheckByCount()) {
      await runEvaluation(bot, state, chatId);
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup — starts the time-based interval checker
// ─────────────────────────────────────────────────────────────────────────────

function setupAutonomous(bot, state, chatId) {
  const intervalMs = TIME_INTERVAL_MIN * 60 * 1000;

  const timer = setInterval(async () => {
    if (!state.enabled) return;
    if (state.shouldCheckByTime()) {
      console.log('[autonomous] Time-based evaluation triggered');
      await runEvaluation(bot, state, chatId);
    }
  }, intervalMs);

  // Don't hold the process open just for this timer
  if (timer.unref) timer.unref();

  console.log(
    `[autonomous] Setup complete — checking every ${MESSAGE_INTERVAL} messages or ${TIME_INTERVAL_MIN} minutes`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Proactive nudges — stale task reminders
// ─────────────────────────────────────────────────────────────────────────────

async function checkStaleTasks(bot, chatId) {
  try {
    const staleTasks = await db.getStaleTasks(3);
    if (!staleTasks.length) return;

    // Group by assignee for one message per person
    const byPerson = {};
    for (const task of staleTasks) {
      if (!byPerson[task.assigned_to]) byPerson[task.assigned_to] = [];
      byPerson[task.assigned_to].push(task);
    }

    for (const [person, tasks] of Object.entries(byPerson)) {
      const taskList = tasks.map((t) => `• ${t.title}`).join('\n');
      const msg = `👋 ${person} — heads up, ${tasks.length === 1 ? 'this task has' : 'these tasks have'} been open 3+ days:\n${taskList}\n\nAnything blocking you?`;
      await bot.api.sendMessage(chatId, msg);
    }
  } catch (err) {
    console.error('[autonomous] Stale task check error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily morning message
// ─────────────────────────────────────────────────────────────────────────────

async function sendDailyNudge(bot, chatId) {
  try {
    const [openTasks] = await Promise.all([db.getAllOpenTasks()]);
    const openCount = openTasks.length;

    const msg = `☀️ Good morning. ${openCount} open task${openCount === 1 ? '' : 's'} across the team. Anything to flag today?`;
    await bot.api.sendMessage(chatId, msg);
  } catch (err) {
    console.error('[autonomous] Daily nudge error:', err.message);
  }
}

module.exports = {
  AutonomousState,
  setupAutonomous,
  onMessage,
  checkStaleTasks,
  sendDailyNudge,
};
