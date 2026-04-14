'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('[db] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Save (upsert) a single message from Telegram.
 * Upserts on telegram_message_id so re-processing on restart is safe.
 */
async function saveMessage(msg) {
  const { error } = await supabase.from('messages').upsert(
    {
      telegram_message_id: msg.telegram_message_id,
      sender_name: msg.sender_name,
      sender_telegram_id: msg.sender_telegram_id,
      text: msg.text || null,
      file_type: msg.file_type || null,
      file_id: msg.file_id || null,
      reply_to_message_id: msg.reply_to_message_id || null,
      tags: msg.tags || null,
      created_at: msg.created_at || new Date().toISOString(),
    },
    { onConflict: 'telegram_message_id', ignoreDuplicates: false }
  );

  if (error) {
    console.error('[db] saveMessage error:', error.message);
  }
}

/**
 * Get recent messages, optionally filtered by a keyword (full-text search).
 * Returns up to `limit` rows, newest first.
 */
async function getRecentMessages(limit = 2000, keyword = null) {
  let query = supabase
    .from('messages')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (keyword) {
    query = query.textSearch('text', keyword, { type: 'websearch', config: 'english' });
  }

  const { data, error } = await query;
  if (error) {
    console.error('[db] getRecentMessages error:', error.message);
    return [];
  }
  return (data || []).reverse(); // chronological order for Claude context
}

/**
 * Get messages since a specific timestamp.
 */
async function getMessagesSince(since, limit = 200) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('[db] getMessagesSince error:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Get messages that contain files, optionally filtered by a keyword.
 */
async function getFileMessages(keyword = null, limit = 10) {
  let query = supabase
    .from('messages')
    .select('*')
    .not('file_type', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (keyword) {
    query = query.ilike('text', `%${keyword}%`);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[db] getFileMessages error:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Update the tags array on a specific message.
 */
async function tagMessage(telegramMessageId, tags) {
  const { error } = await supabase
    .from('messages')
    .update({ tags })
    .eq('telegram_message_id', telegramMessageId);

  if (error) {
    console.error('[db] tagMessage error:', error.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TASKS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new task row.
 */
async function createTask(task) {
  const { data, error } = await supabase
    .from('tasks')
    .insert({
      title: task.title,
      description: task.description || null,
      assigned_to: task.assigned_to,
      status: task.status || 'open',
      priority: task.priority || 'normal',
      created_by: task.created_by,
      source_message_id: task.source_message_id || null,
      due_date: task.due_date || null,
    })
    .select()
    .single();

  if (error) {
    console.error('[db] createTask error:', error.message);
    return null;
  }
  return data;
}

/**
 * Bulk-insert tasks (used by /todos command).
 */
async function createTasks(tasks) {
  const { data, error } = await supabase
    .from('tasks')
    .insert(tasks)
    .select();

  if (error) {
    console.error('[db] createTasks error:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Update a task's status. Automatically sets completed_at if status = 'done'.
 */
async function updateTaskStatus(id, status) {
  const update = { status };
  if (status === 'done') {
    update.completed_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('tasks')
    .update(update)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('[db] updateTaskStatus error:', error.message);
    return null;
  }
  return data;
}

/**
 * Get all open tasks for a given person's name.
 */
async function getUserTasks(name) {
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('assigned_to', name)
    .in('status', ['open', 'in_progress'])
    .order('priority', { ascending: false }) // high first
    .order('created_at', { ascending: true }); // oldest first

  if (error) {
    console.error('[db] getUserTasks error:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Get ALL open tasks grouped by assignee (raw, grouping done in utils).
 */
async function getAllOpenTasks() {
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .in('status', ['open', 'in_progress'])
    .order('assigned_to', { ascending: true })
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[db] getAllOpenTasks error:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Get tasks open for 3+ days with no reminder sent yet (for proactive nudges).
 */
async function getStaleTasks(daysOld = 3) {
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .in('status', ['open', 'in_progress'])
    .lte('created_at', cutoff);

  if (error) {
    console.error('[db] getStaleTasks error:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Find tasks by title fuzzy match (for /done command).
 */
async function findTaskByTitle(searchText) {
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .ilike('title', `%${searchText}%`)
    .in('status', ['open', 'in_progress'])
    .limit(5);

  if (error) {
    console.error('[db] findTaskByTitle error:', error.message);
    return [];
  }
  return data || [];
}

// ─────────────────────────────────────────────────────────────────────────────
// DECISIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log a new decision.
 */
async function createDecision(decision) {
  const { data, error } = await supabase
    .from('decisions')
    .insert({
      decision: decision.decision,
      context: decision.context || null,
      decided_by: decision.decided_by,
      source_message_id: decision.source_message_id || null,
    })
    .select()
    .single();

  if (error) {
    console.error('[db] createDecision error:', error.message);
    return null;
  }
  return data;
}

/**
 * Get the most recent decisions.
 */
async function getRecentDecisions(limit = 10) {
  const { data, error } = await supabase
    .from('decisions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[db] getRecentDecisions error:', error.message);
    return [];
  }
  return (data || []).reverse();
}

// ─────────────────────────────────────────────────────────────────────────────
// TEAM MEMBERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get all team members (used for assignee resolution and dashboard dropdown).
 */
async function getTeamMembers() {
  const { data, error } = await supabase
    .from('team_members')
    .select('*')
    .order('name', { ascending: true });

  if (error) {
    console.error('[db] getTeamMembers error:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Resolve a Telegram user ID to a team member name.
 */
async function getTeamMemberName(telegramId) {
  const { data, error } = await supabase
    .from('team_members')
    .select('name')
    .eq('telegram_id', telegramId)
    .single();

  if (error) return null;
  return data?.name || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERVENTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log an autonomous bot intervention.
 */
async function logIntervention(triggerReason, messageText) {
  const { error } = await supabase.from('interventions').insert({
    trigger_reason: triggerReason,
    message_text: messageText,
  });

  if (error) {
    console.error('[db] logIntervention error:', error.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STATS (for Activity Pulse on web dashboard)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns aggregate stats for a given time period.
 */
async function getStats() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [messagesResult, tasksCreatedResult, tasksCompletedResult, decisionsResult] =
    await Promise.all([
      supabase.from('messages').select('id', { count: 'exact', head: true }).gte('created_at', todayStart),
      supabase.from('tasks').select('id', { count: 'exact', head: true }).gte('created_at', weekStart),
      supabase.from('tasks').select('id', { count: 'exact', head: true }).eq('status', 'done').gte('completed_at', weekStart),
      supabase.from('decisions').select('id', { count: 'exact', head: true }).gte('created_at', weekStart),
    ]);

  return {
    messagesToday: messagesResult.count || 0,
    tasksCreatedThisWeek: tasksCreatedResult.count || 0,
    tasksCompletedThisWeek: tasksCompletedResult.count || 0,
    decisionsThisWeek: decisionsResult.count || 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// KNOWLEDGE BASE
// ─────────────────────────────────────────────────────────────────────────────

async function getKnowledgeBase() {
  const { data, error } = await supabase
    .from('knowledge_base')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[db] getKnowledgeBase error:', error.message);
    return [];
  }
  return data;
}

async function addKnowledgeFacts(facts, source = 'auto') {
  if (!facts || facts.length === 0) return [];
  
  const rows = facts.map(fact => ({ fact, source }));
  const { data, error } = await supabase
    .from('knowledge_base')
    .insert(rows)
    .select();

  if (error) {
    console.error('[db] addKnowledgeFacts error:', error.message);
    return [];
  }
  return data;
}

async function deleteKnowledgeFact(id) {
  const { error } = await supabase
    .from('knowledge_base')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('[db] deleteKnowledgeFact error:', error.message);
    return false;
  }
  return true;
}

module.exports = {
  saveMessage,
  getRecentMessages,
  getMessagesSince,
  getFileMessages,
  tagMessage,
  createTask,
  createTasks,
  updateTaskStatus,
  getUserTasks,
  getAllOpenTasks,
  getStaleTasks,
  findTaskByTitle,
  createDecision,
  getRecentDecisions,
  getTeamMembers,
  getTeamMemberName,
  logIntervention,
  getStats,
  getKnowledgeBase,
  addKnowledgeFacts,
  deleteKnowledgeFact,
};
