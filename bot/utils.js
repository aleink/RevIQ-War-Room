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
 * Format tasks specifically for the AI system prompt (includes UUIDs for tool calling).
 */
function formatTasksForAI(tasks) {
  if (!tasks.length) return 'No open tasks.';
  return tasks
    .map(t => `[ID: ${t.id}] ${t.title} (Assignee: ${t.assigned_to}, Priority: ${t.priority}, Status: ${t.status})`)
    .join('\n');
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

/**
 * Download a file from Telegram and convert it to Base64 with MimeType.
 */
async function downloadTelegramFile(ctx, fileId, overrideMime = null) {
  try {
    const file = await ctx.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP Error: ${res.statusText}`);
    
    const arrayBuffer = await res.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    
    const ext = file.file_path.split('.').pop().toLowerCase();
    const MIME_MAP = {
      // Images (Gemini native vision/OCR)
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
      tiff: 'image/tiff', tif: 'image/tiff', heic: 'image/heic',
      svg: 'image/svg+xml',
      // Documents
      pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
      md: 'text/markdown', json: 'application/json',
      html: 'text/html', htm: 'text/html', xml: 'text/xml',
      // Office (Gemini supports these natively)
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc: 'application/msword',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xls: 'application/vnd.ms-excel',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ppt: 'application/vnd.ms-powerpoint',
      // Audio (Gemini native)
      ogg: 'audio/ogg', oga: 'audio/ogg', mp3: 'audio/mpeg',
      wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
      flac: 'audio/flac', opus: 'audio/opus',
      // Video (Gemini native)
      mp4: 'video/mp4', mpeg: 'video/mpeg', mov: 'video/quicktime',
      avi: 'video/x-msvideo', webm: 'video/webm',
    };
    const mimeType = overrideMime || MIME_MAP[ext];
    if (!mimeType || mimeType === 'application/octet-stream') {
      console.warn(`[utils] Skipping unsupported file type: .${ext} (${overrideMime || 'no override'})`);
      return null;
    }

    return { 
      inlineData: {
        data: base64,
        mimeType
      }
    };
  } catch (err) {
    console.error('[utils] fetch file error:', err.message);
    return null;
  }
}

/**
 * Extract the best file attachment from a message context and download it.
 * Handles photos, documents, voice notes, video notes, audio, video, and stickers.
 */
async function processMessageAttachment(ctx) {
  const msg = ctx.message;
  if (!msg) return null;

  // Try extracting from the current message first, then fall back to the replied-to message
  const sources = [msg];
  if (msg.reply_to_message) sources.push(msg.reply_to_message);

  for (const src of sources) {
    const result = extractFileInfo(src);
    if (result) return downloadTelegramFile(ctx, result.fileId, result.overrideMime);
  }

  return null;
}

/**
 * Extract fileId and MIME from a Telegram message object.
 */
function extractFileInfo(msg) {
  if (msg.photo && msg.photo.length > 0) {
    return { fileId: msg.photo[msg.photo.length - 1].file_id, overrideMime: null };
  }
  if (msg.document) {
    return { fileId: msg.document.file_id, overrideMime: msg.document.mime_type || null };
  }
  if (msg.voice) {
    return { fileId: msg.voice.file_id, overrideMime: msg.voice.mime_type || 'audio/ogg' };
  }
  if (msg.audio) {
    return { fileId: msg.audio.file_id, overrideMime: msg.audio.mime_type || null };
  }
  if (msg.video) {
    return { fileId: msg.video.file_id, overrideMime: msg.video.mime_type || null };
  }
  if (msg.video_note) {
    return { fileId: msg.video_note.file_id, overrideMime: 'video/mp4' };
  }
  if (msg.sticker && !msg.sticker.is_animated) {
    return { fileId: msg.sticker.file_id, overrideMime: 'image/webp' };
  }
  return null;
}

/**
 * Sanitize Markdown for Telegram — fix unclosed entities that cause
 * "can't parse entities" 400 errors.
 */
function sanitizeMarkdown(text) {
  if (!text) return text;
  // Count occurrences of unescaped formatting chars
  const chars = ['*', '_', '`'];
  for (const ch of chars) {
    const regex = ch === '*' ? /(?<!\\)\*/g :
                  ch === '_' ? /(?<!\\)_/g :
                               /(?<!\\)`/g;
    const matches = text.match(regex);
    if (matches && matches.length % 2 !== 0) {
      // Odd count = unclosed entity — append closing char
      text += ch;
    }
  }
  return text;
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
  downloadTelegramFile,
  processMessageAttachment,
  formatTasksForAI,
  sanitizeMarkdown,
};
