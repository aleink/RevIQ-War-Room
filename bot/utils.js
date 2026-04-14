'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Utilities — formatting, deep links, date helpers, priority sort
// ─────────────────────────────────────────────────────────────────────────────

const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

/**
 * Format a single task as a readable Telegram string.
 */
function formatTask(task, index = null) {
  const priority = task.priority === 'high' ? '🔴' : task.priority === 'low' ? '⚪' : '🟡';
  const age = daysOpen(task.created_at);
  const ageLabel = age === 0 ? 'today' : age === 1 ? '1 day' : `${age} days`;
  const prefix = index !== null ? `${index}. ` : '• ';

  return `${prefix}${priority} *${task.title}*\n   → ${task.assigned_to} · ${ageLabel} open`;
}

/**
 * Format a list of tasks grouped by assignee.
 */
function formatTasksByAssignee(tasks) {
  if (!tasks.length) return '_No open tasks. Enjoy it while it lasts._';

  const grouped = {};
  for (const task of tasks) {
    if (!grouped[task.assigned_to]) grouped[task.assigned_to] = [];
    grouped[task.assigned_to].push(task);
  }

  const lines = [];
  for (const [person, personTasks] of Object.entries(grouped)) {
    lines.push(`*${person}*`);
    personTasks.forEach((t, i) => lines.push(formatTask(t, i + 1)));
    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * Format a single decision.
 */
function formatDecision(decision) {
  const date = formatDate(decision.created_at);
  const context = decision.context ? `\n   _${decision.context}_` : '';
  return `📌 *${decision.decision}*\n   ${decision.decided_by} · ${date}${context}`;
}

/**
 * Build a Telegram deep link to a specific message in a group.
 * Works for public groups and supergroups.
 */
function buildTelegramDeepLink(chatId, messageId) {
  // chatId is usually negative for groups, e.g. -1001234567890
  // Telegram deep link format requires the positive ID without the leading -100
  const numericId = String(chatId).replace(/^-100/, '');
  return `https://t.me/c/${numericId}/${messageId}`;
}

/**
 * Format a UTC ISO timestamp to a human-readable date string.
 */
function formatDate(isoString) {
  if (!isoString) return 'unknown date';
  const d = new Date(isoString);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Calculate how many full days ago a timestamp was from now.
 */
function daysOpen(isoString) {
  if (!isoString) return 0;
  const diff = Date.now() - new Date(isoString).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

/**
 * Sort tasks: high priority → normal → low, then oldest first within each tier.
 */
function prioritySort(tasks) {
  return [...tasks].sort((a, b) => {
    const pDiff = (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1);
    if (pDiff !== 0) return pDiff;
    return new Date(a.created_at) - new Date(b.created_at);
  });
}

/**
 * Split text into chunks no larger than maxLen characters.
 * Splits on newlines where possible to avoid cutting mid-sentence.
 */
function chunkText(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let current = '';

  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > maxLen) {
      if (current) chunks.push(current.trim());
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }

  if (current) chunks.push(current.trim());
  return chunks;
}

/**
 * Resolve a name or @username mention from a message to a clean name.
 * Tries to match against team members list.
 */
function resolveAssignee(mention, teamMembers) {
  const clean = mention.replace('@', '').toLowerCase();
  const match = teamMembers.find(
    (m) =>
      m.name.toLowerCase() === clean ||
      m.telegram_username.toLowerCase() === clean
  );
  return match ? match.name : mention.replace('@', '');
}

/**
 * Format a context block of messages for Claude.
 * Returns a compact string with sender + timestamp + text for each message.
 */
function formatMessagesForContext(messages) {
  if (!messages.length) return '(no recent messages)';
  return messages
    .map((m) => {
      const time = formatDate(m.created_at);
      const text = m.text || `[${m.file_type || 'file'} shared]`;
      return `[${time}] ${m.sender_name}: ${text}`;
    })
    .join('\n');
}

/**
 * Extract @mentions from a Telegram message text.
 */
function extractMentions(text) {
  if (!text) return [];
  const matches = text.match(/@\w+/g) || [];
  return matches.map((m) => m.toLowerCase());
}

/**
 * Check if a message mentions the bot.
 */
function mentionsBot(text, botUsername) {
  if (!text || !botUsername) return false;
  return text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
}

/**
 * Get ISO string for N hours ago.
 */
function hoursAgo(n) {
  return new Date(Date.now() - n * 60 * 60 * 1000).toISOString();
}

/**
 * Get ISO string for N days ago.
 */
function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

module.exports = {
  formatTask,
  formatTasksByAssignee,
  formatDecision,
  buildTelegramDeepLink,
  formatDate,
  daysOpen,
  prioritySort,
  chunkText,
  resolveAssignee,
  formatMessagesForContext,
  extractMentions,
  mentionsBot,
  hoursAgo,
  daysAgo,
};
