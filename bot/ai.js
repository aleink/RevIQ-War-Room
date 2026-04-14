'use strict';

require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MODEL = 'gemini-1.5-flash';
const MAX_RETRIES = 3;

// ─────────────────────────────────────────────────────────────────────────────
// System prompt — embedded co-founder persona
// ─────────────────────────────────────────────────────────────────────────────

const CO_FOUNDER_SYSTEM_PROMPT = `You are a co-founder embedded in a startup team's Telegram group for RevIQ — an AI-powered post-service customer intelligence SaaS platform for local businesses. You have access to the full history of the team's conversations, tasks, and decisions.

Your personality:
- Direct and concise. No fluff, no corporate jargon.
- Opinionated. When asked for input, give ONE clear recommendation, not a menu of options.
- You think like someone with skin in the game — revenue, deadlines, and execution matter to you.
- You push back when the team is overcomplicating things or going off track.
- You remember what was discussed before and connect dots the team might miss.

Rules:
- Never ramble. Max 2 short paragraphs unless asked to summarize or generate a list.
- When asked to find something, return the specific info with context (who said it, when).
- When extracting tasks, be specific about the action and who owns it.
- Use plain English. Write like a human teammate texting, not an AI assistant.`;

// ─────────────────────────────────────────────────────────────────────────────
// Format Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatTime(isoStr) {
  try {
    const d = new Date(isoStr);
    return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch (e) {
    return isoStr;
  }
}

function formatMessageContext(messages) {
  if (!messages || !messages.length) return '(no messages)';
  return messages.map((m) => `[\${m.sender_name} at \${formatTime(m.created_at)}]: \${m.text || '[file]'}`).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Autonomous evaluation prompt
// ─────────────────────────────────────────────────────────────────────────────

function buildAutonomousPrompt(recentMessages, openTasks, recentDecisions) {
  const tasksBlock = openTasks.length
    ? openTasks.map((t) => `- [\${t.priority}] \${t.title} → \${t.assigned_to} (\${t.status})`).join('\n')
    : 'No open tasks.';

  const decisionsBlock = recentDecisions.length
    ? recentDecisions.map((d) => `- \${d.decision} (by \${d.decided_by})`).join('\n')
    : 'No recent decisions.';

  const messagesBlock = formatMessageContext(recentMessages);

  return `You are monitoring a startup team's group chat. Review these recent messages along with the team's current open tasks and recent decisions provided below.

=== RECENT MESSAGES ===
\${messagesBlock}

=== OPEN TASKS ===
\${tasksBlock}

=== RECENT DECISIONS ===
\${decisionsBlock}

Should you intervene? Only intervene if one of these conditions is clearly true:

1. CONTRADICTION — Someone said something that conflicts with a previous decision the team logged.
2. FORGOTTEN_TASK — The team is discussing something they already have an open task for and don't seem to realize it.
3. GOING_IN_CIRCLES — The conversation is repeating the same debate without reaching a decision.
4. MISSED_BLOCKER — Someone casually mentioned something that could block launch progress and nobody picked up on it.
5. SCOPE_CREEP — The team is drifting into building or planning something that's out of scope for the current launch phase.
6. QUICK_WIN — There's an obvious easy action nobody has claimed.
7. IGNORED_QUESTION — Someone asked something important and it got buried with no response.

If NONE of these clearly apply, respond with exactly: SILENT
If one applies, respond with a short message — one paragraph max. Be direct. Don't be annoying. Don't repeat what's already been said. Add value or stay quiet.
Start your first word with the trigger label in brackets, e.g. [CONTRADICTION] or [MISSED_BLOCKER], then a space, then your message.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Gemini call with retry
// ─────────────────────────────────────────────────────────────────────────────

async function callGemini(userMessage, systemPrompt = CO_FOUNDER_SYSTEM_PROMPT, isJson = false, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const modelConfig = { 
        model: MODEL,
        systemInstruction: systemPrompt 
      };

      if (isJson) {
        modelConfig.generationConfig = { responseMimeType: "application/json" };
      }

      const model = genAI.getGenerativeModel(modelConfig);
      const result = await model.generateContent(userMessage);
      
      return result.response.text().trim() || null;
    } catch (err) {
      const isRateLimit = err?.status === 429;
      const isOverload = err?.status === 529 || err?.status === 503;

      if ((isRateLimit || isOverload) && attempt < retries) {
        const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
        console.warn(`[ai] Gemini API \${err.status || 'Error'} — retrying in \${delay}ms (attempt \${attempt}/\${retries})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      console.error('[ai] Gemini API error:', err?.message || err);
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * General Q&A — used by /ask and @mention handlers.
 * Includes formatted context messages in the user message.
 */
async function askGemini(userQuestion, contextMessages = []) {
  const contextBlock = contextMessages.length
    ? `\n\n=== RECENT CONVERSATION CONTEXT (Chronological - Last \${contextMessages.length} messages) ===\nCurrent Time: \${formatTime(new Date().toISOString())}\n\n\${formatMessageContext(contextMessages)}`
    : '';

  const prompt = `\${userQuestion}\${contextBlock}`;
  return callGemini(prompt);
}

/**
 * Extract action items from a batch of messages.
 * Returns structured JSON array of tasks.
 */
async function extractTasks(messages, teamMembers) {
  const teamList = teamMembers.map((m) => m.name).join(', ');
  const messagesText = formatMessageContext(messages);

  const prompt = `Extract every action item from these Telegram messages. Team members: \${teamList}.

For each action item, return a JSON object with:
- title: short action description (verb + object, e.g. "Build landing page")
- assigned_to: best-guess person from the team list, or "Unassigned"
- priority: "high", "normal", or "low" based on urgency signals in the text

Return ONLY a valid JSON array. No explanation. No markdown. Example:
[{"title":"Fix pricing page","assigned_to":"Marcus","priority":"high"}]

Messages:
\${messagesText}`;

  const response = await callGemini(prompt, CO_FOUNDER_SYSTEM_PROMPT, true);

  try {
    const parsed = JSON.parse(response);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    // Falback to regex match if strict JSON parsing fails
    try {
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];
      return JSON.parse(jsonMatch[0]);
    } catch (e2) {
      console.error('[ai] extractTasks parse error:', e2.message, '\nRaw response:', response);
      return [];
    }
  }
}

/**
 * Auto-categorize a message with a tag.
 */
async function categorizeMessage(messageText) {
  const prompt = `Categorize this Telegram message with exactly ONE tag from this list:
#task, #decision, #idea, #blocker, #reference

Message: "\${messageText}"

Reply with ONLY the tag. Nothing else.`;

  const response = await callGemini(prompt);
  const validTags = ['#task', '#decision', '#idea', '#blocker', '#reference'];
  const tag = response?.trim().toLowerCase();
  return validTags.includes(tag) ? tag : '#reference';
}

/**
 * Generate a recap summary.
 */
async function generateRecap(messages, tasks, decisions, period = '24 hours') {
  const messagesText = formatMessageContext(messages);

  const tasksText = tasks.length
    ? tasks.map((t) => `- \${t.title} → \${t.assigned_to} [\${t.status}]`).join('\n')
    : 'None';

  const decisionsText = decisions.length
    ? decisions.map((d) => `- \${d.decision} (by \${d.decided_by})`).join('\n')
    : 'None';

  const prompt = `Summarize this startup team's activity over the last \${period}.

Messages (\${messages.length} total):
\${messagesText}

Tasks:
\${tasksText}

Decisions:
\${decisionsText}

Include: messages exchanged, tasks created, tasks completed, decisions logged, key topics, open questions, any blockers mentioned.
Be concise. Use bullet points. Write like a team member, not a report generator.`;

  return callGemini(prompt);
}

/**
 * Generate a weekly recap with per-member contributions.
 */
async function generateWeeklyRecap(messages, tasks, decisions, teamMembers) {
  const teamNames = teamMembers.map((m) => m.name);
  const messagesText = formatMessageContext(messages);

  const prompt = `Generate a structured weekly recap for this startup team.

Team members: \${teamNames.join(', ')}

Messages this week:
\${messagesText}

Tasks (all):
\${tasks.map((t) => `- \${t.title} → \${t.assigned_to} [\${t.status}]\${t.status === 'done' ? ' ✓' : ''}`).join('\n')}

Decisions this week:
\${decisions.map((d) => `- \${d.decision} (by \${d.decided_by})`).join('\n')}

Format:
📊 *Week in Numbers*
(messages, tasks created, tasks completed, decisions)

Then a section for each team member who was active:
👤 *[Name]*
- Contributed: [what they worked on]
- Open items: [their open tasks]

End with:
🚧 *Blockers / Open Questions*
📌 *Key Decisions Made*`;

  return callGemini(prompt, CO_FOUNDER_SYSTEM_PROMPT);
}

/**
 * Evaluate whether the bot should autonomously intervene.
 * Returns either "SILENT" or a message string starting with a trigger label.
 */
async function evaluateAutonomous(recentMessages, openTasks, recentDecisions) {
  const prompt = buildAutonomousPrompt(recentMessages, openTasks, recentDecisions);
  const response = await callGemini(prompt, CO_FOUNDER_SYSTEM_PROMPT);
  return response || 'SILENT';
}

module.exports = {
  askGemini,
  extractTasks,
  categorizeMessage,
  generateRecap,
  generateWeeklyRecap,
  evaluateAutonomous,
  CO_FOUNDER_SYSTEM_PROMPT,
};
