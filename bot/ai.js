'use strict';

require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db');
const { formatTasksForAI } = require('./utils');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MODEL = 'gemini-2.5-flash';
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
  return messages.map((m) => `[${m.sender_name} at ${formatTime(m.created_at)}]: ${m.text || '[file]'}`).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Autonomous evaluation prompt
// ─────────────────────────────────────────────────────────────────────────────

function buildAutonomousPrompt(recentMessages, openTasks, recentDecisions) {
  const tasksBlock = openTasks.length
    ? openTasks.map((t) => `- [${t.priority}] ${t.title} → ${t.assigned_to} (${t.status})`).join('\n')
    : 'No open tasks.';

  const decisionsBlock = recentDecisions.length
    ? recentDecisions.map((d) => `- ${d.decision} (by ${d.decided_by})`).join('\n')
    : 'No recent decisions.';

  const messagesBlock = formatMessageContext(recentMessages);

  return `You are monitoring a startup team's group chat. Review these recent messages along with the team's current open tasks and recent decisions provided below.

=== RECENT MESSAGES ===
${messagesBlock}

=== OPEN TASKS ===
${tasksBlock}

=== RECENT DECISIONS ===
${decisionsBlock}

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
        console.warn(`[ai] Gemini API ${err.status || 'Error'} — retrying in ${delay}ms (attempt ${attempt}/${retries})`);
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

function buildDynamicSystemPrompt(teamMembers = [], kbFacts = [], openTasks = []) {
  let prompt = CO_FOUNDER_SYSTEM_PROMPT;

  if (teamMembers.length > 0) {
    prompt += '\n\n=== TEAM ROSTER ===\n';
    teamMembers.forEach(m => {
      prompt += `- ${m.name} (${m.role}): mapped to telegram @${m.telegram_username}\n`;
    });
  }

  if (kbFacts.length > 0) {
    prompt += '\n\n=== REVIQ KNOWLEDGE BASE ===\n(Permanent facts you must remember and adhere to)\n';
    kbFacts.forEach(k => {
      prompt += `- ${k.fact}\n`;
    });
  }

  if (openTasks.length > 0) {
    prompt += '\n\n=== CURRENT OPEN TASKS ===\n';
    prompt += formatTasksForAI(openTasks);
  }

  return prompt;
}

const TASK_TOOLS = [{
  functionDeclarations: [
    {
      name: "create_task",
      description: "Create a new assigned task in the database.",
      parameters: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING", description: "Short, actionable title of the task" },
          assigned_to: { type: "STRING", description: "Name of the team member to assign it to" },
          priority: { type: "STRING", description: "high, normal, or low" }
        },
        required: ["title", "assigned_to", "priority"]
      }
    },
    {
      name: "update_task_status",
      description: "Change the status of an existing task.",
      parameters: {
        type: "OBJECT",
        properties: {
          task_id: { type: "STRING", description: "The UUID of the task to update" },
          status: { type: "STRING", description: "The new status: open, in_progress, or done" }
        },
        required: ["task_id", "status"]
      }
    }
  ]
}];

async function executeAgenticLoop(content, systemPrompt) {
  const modelConfig = { 
    model: MODEL,
    systemInstruction: systemPrompt,
    tools: TASK_TOOLS
  };

  const model = genAI.getGenerativeModel(modelConfig);
  const chat = model.startChat();
  
  let result = await chat.sendMessage(content);
  
  if (result.response.functionCalls && typeof result.response.functionCalls === 'function' && result.response.functionCalls()) {
    const calls = result.response.functionCalls();
    const functionResponses = [];
    
    for (const call of calls) {
      if (call.name === 'create_task') {
        const { title, assigned_to, priority } = call.args;
        const task = await db.createTask({ title, assigned_to, priority, created_by: 'RevIQ Agent' });
        functionResponses.push({
          functionResponse: { name: 'create_task', response: { success: !!task, task_id: task?.id } }
        });
      } else if (call.name === 'update_task_status') {
        const { task_id, status } = call.args;
        const updated = await db.updateTaskStatus(task_id, status);
        functionResponses.push({
          functionResponse: { name: 'update_task_status', response: { success: !!updated } }
        });
      }
    }
    
    if (functionResponses.length > 0) {
      result = await chat.sendMessage(functionResponses);
    }
  }
  
  return result.response.text().trim() || null;
}

/**
 * General Q&A — used by /ask and @mention handlers.
 * Includes formatted context messages in the user message.
 */
async function askGemini(userQuestion, contextMessages = [], teamMembers = [], kbFacts = [], attachments = [], openTasks = []) {
  const contextBlock = contextMessages.length
    ? `\n\n=== RECENT CONVERSATION CONTEXT (Chronological - Last ${contextMessages.length} messages) ===\nCurrent Time: ${formatTime(new Date().toISOString())}\n\n${formatMessageContext(contextMessages)}`
    : '';

  const promptText = `${userQuestion}${contextBlock}`;
  const dynamicSystemPrompt = buildDynamicSystemPrompt(teamMembers, kbFacts, openTasks);
  
  let content = promptText;
  if (attachments && attachments.length > 0) {
    // Generate multimodal prompt array
    content = [...attachments, promptText];
  }
  
  return executeAgenticLoop(content, dynamicSystemPrompt);
}

/**
 * Extract action items from a batch of messages.
 * Returns structured JSON array of tasks.
 */
async function extractTasks(messages, teamMembers) {
  const teamList = teamMembers.map((m) => m.name).join(', ');
  const messagesText = formatMessageContext(messages);

  const prompt = `Extract every action item from these Telegram messages. Team members: ${teamList}.

For each action item, return a JSON object with:
- title: short action description (verb + object, e.g. "Build landing page")
- assigned_to: best-guess person from the team list, or "Unassigned"
- priority: "high", "normal", or "low" based on urgency signals in the text

Return ONLY a valid JSON array. No explanation. No markdown. Example:
[{"title":"Fix pricing page","assigned_to":"Marcus","priority":"high"}]

Messages:
${messagesText}`;

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
 * Extract permanent facts to store in the knowledge base, and prune old contradicted ones.
 * Optionally parses attached multimodal documents.
 */
async function extractKnowledge(messages, currentKbFacts = [], attachments = []) {
  const messagesText = formatMessageContext(messages);
  const currentKbText = currentKbFacts.length 
    ? currentKbFacts.map(k => `[ID: ${k.id}] ${k.fact}`).join('\n')
    : '(No existing facts)';

  const promptText = `Review these recent Telegram messages and any attached documents. Extract any NEW foundational, permanent facts about the company, the team, the project, or the business logic. 
Focus ONLY on things worth remembering long-term (e.g. "We changed pricing to $299", "Sarah is now handling UX", "Our main competitor is X", "We integrate with Supabase via REST").
Ignore fleeting thoughts, jokes, daily tasks, or ordinary conversation.

Here is what you currently know in your permanent Knowledge Base:
${currentKbText}

If a NEW fact completely contradicts and overrides an OLD fact (for example, if pricing changed from $99 to $299), you must DELETE the old fact by its ID, and ADD the new fact.

Return ONLY a valid JSON object with an "add" array of new strings, and a "delete" array of UUID strings to remove.
Example: {"add": ["Pricing model is now $299/mo", "Marcus handles DB"], "delete": ["abc-123-uuid"]}

Messages:
${messagesText}`;

  let content = promptText;
  if (attachments && attachments.length > 0) {
    content = [...attachments, promptText];
  }

  const response = await callGemini(content, CO_FOUNDER_SYSTEM_PROMPT, true);

  const emptyResult = { add: [], delete: [] };
  try {
    const parsed = JSON.parse(response);
    return {
      add: Array.isArray(parsed.add) ? parsed.add : [],
      delete: Array.isArray(parsed.delete) ? parsed.delete : []
    };
  } catch (e) {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return emptyResult;
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        add: Array.isArray(parsed.add) ? parsed.add : [],
        delete: Array.isArray(parsed.delete) ? parsed.delete : []
      };
    } catch (e2) {
      console.error('[ai] extractKnowledge parse error:', e2.message);
      return emptyResult;
    }
  }
}

/**
 * Auto-categorize a message with a tag.
 */
async function categorizeMessage(messageText) {
  const prompt = `Categorize this Telegram message with exactly ONE tag from this list:
#task, #decision, #idea, #blocker, #reference

Message: "${messageText}"

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
    ? tasks.map((t) => `- ${t.title} → ${t.assigned_to} [${t.status}]`).join('\n')
    : 'None';

  const decisionsText = decisions.length
    ? decisions.map((d) => `- ${d.decision} (by ${d.decided_by})`).join('\n')
    : 'None';

  const prompt = `Summarize this startup team's activity over the last ${period}.

Messages (${messages.length} total):
${messagesText}

Tasks:
${tasksText}

Decisions:
${decisionsText}

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

Team members: ${teamNames.join(', ')}

Messages this week:
${messagesText}

Tasks (all):
${tasks.map((t) => `- ${t.title} → ${t.assigned_to} [${t.status}]${t.status === 'done' ? ' ✓' : ''}`).join('\n')}

Decisions this week:
${decisions.map((d) => `- ${d.decision} (by ${d.decided_by})`).join('\n')}

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
  extractKnowledge,
  categorizeMessage,
  generateRecap,
  generateWeeklyRecap,
  evaluateAutonomous,
  CO_FOUNDER_SYSTEM_PROMPT,
};
