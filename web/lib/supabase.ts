import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// ─────────────────────────────────────────────────────────────────────────────
// Browser client — used by client components and Realtime subscriptions
// ─────────────────────────────────────────────────────────────────────────────
let browserClient: ReturnType<typeof createClient> | null = null;

export function createBrowserClient() {
  if (browserClient) return browserClient;
  browserClient = createClient(supabaseUrl, supabaseAnonKey, {
    realtime: {
      params: { eventsPerSecond: 10 },
    },
  });
  return browserClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server client — used by server components (service key not exposed to client)
// ─────────────────────────────────────────────────────────────────────────────
export function createServerClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (!url) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL');

  // Use service key if available (for server components), fall back to anon key
  const key = serviceKey || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) throw new Error('Missing Supabase key');

  return createClient(url, key);
}

// ─────────────────────────────────────────────────────────────────────────────
// Task types
// ─────────────────────────────────────────────────────────────────────────────

export interface Task {
  id: string;
  title: string;
  description: string | null;
  assigned_to: string;
  status: 'open' | 'in_progress' | 'done';
  priority: 'low' | 'normal' | 'high';
  created_by: string;
  source_message_id: number | null;
  due_date: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface Decision {
  id: string;
  decision: string;
  context: string | null;
  decided_by: string;
  source_message_id: number | null;
  created_at: string;
}

export interface TeamMember {
  id: string;
  name: string;
  telegram_username: string;
  telegram_id: number;
  role: string;
}

export interface Stats {
  messagesToday: number;
  tasksCreatedThisWeek: number;
  tasksCompletedThisWeek: number;
  decisionsThisWeek: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Realtime subscription helpers
// ─────────────────────────────────────────────────────────────────────────────

type RealtimeCallback<T> = (payload: { new: T; old: T; eventType: string }) => void;

export function subscribeToTasks(callback: RealtimeCallback<Task>) {
  const client = createBrowserClient();
  const channel = client
    .channel('tasks-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, (payload) => {
      callback({
        new: payload.new as Task,
        old: payload.old as Task,
        eventType: payload.eventType,
      });
    })
    .subscribe();

  return () => { client.removeChannel(channel); };
}

export function subscribeToDecisions(callback: RealtimeCallback<Decision>) {
  const client = createBrowserClient();
  const channel = client
    .channel('decisions-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'decisions' }, (payload) => {
      callback({
        new: payload.new as Decision,
        old: payload.old as Decision,
        eventType: payload.eventType,
      });
    })
    .subscribe();

  return () => { client.removeChannel(channel); };
}
