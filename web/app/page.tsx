import { createServerClient } from '@/lib/supabase';
import QuickAdd from '@/components/QuickAdd';
import TaskList from '@/components/TaskList';
import CompletedTasks from '@/components/CompletedTasks';
import DecisionLog from '@/components/DecisionLog';
import ActivityPulse from '@/components/ActivityPulse';

// ─────────────────────────────────────────────────────────────────────────────
// Access guard — validate ?token= query param
// ─────────────────────────────────────────────────────────────────────────────

function AccessDenied() {
  return (
    <div className="access-denied">
      <h1>Access Denied</h1>
      <p>This dashboard requires a valid token in the URL. Ask a teammate for the link.</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Server-side data fetching
// ─────────────────────────────────────────────────────────────────────────────

async function getInitialData() {
  const supabase = createServerClient();

  const [tasksRes, completedRes, decisionsRes, membersRes] = await Promise.all([
    supabase
      .from('tasks')
      .select('*')
      .in('status', ['open', 'in_progress'])
      .order('assigned_to')
      .order('priority')
      .order('created_at'),

    supabase
      .from('tasks')
      .select('*')
      .eq('status', 'done')
      .order('completed_at', { ascending: false })
      .limit(10),

    supabase
      .from('decisions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50),

    supabase
      .from('team_members')
      .select('*')
      .order('name'),
  ]);

  // Stats
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [msgCount, taskCreatedCount, taskDoneCount, decisionCount] = await Promise.all([
    supabase.from('messages').select('id', { count: 'exact', head: true }).gte('created_at', todayStart),
    supabase.from('tasks').select('id', { count: 'exact', head: true }).gte('created_at', weekStart),
    supabase.from('tasks').select('id', { count: 'exact', head: true }).eq('status', 'done').gte('completed_at', weekStart),
    supabase.from('decisions').select('id', { count: 'exact', head: true }).gte('created_at', weekStart),
  ]);

  return {
    openTasks: tasksRes.data || [],
    completedTasks: completedRes.data || [],
    decisions: decisionsRes.data || [],
    teamMembers: membersRes.data || [],
    stats: {
      messagesToday: msgCount.count || 0,
      tasksCreatedThisWeek: taskCreatedCount.count || 0,
      tasksCompletedThisWeek: taskDoneCount.count || 0,
      decisionsThisWeek: decisionCount.count || 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Page Component
// ─────────────────────────────────────────────────────────────────────────────

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function DashboardPage({ searchParams }: PageProps) {
  const { token } = await searchParams;
  const expectedToken = process.env.DASHBOARD_TOKEN;

  if (!expectedToken || token !== expectedToken) {
    return <AccessDenied />;
  }

  const { openTasks, completedTasks, decisions, teamMembers, stats } = await getInitialData();

  return (
    <main>
      <div className="container">
        {/* Header */}
        <header className="page-header">
          <h1>
            RevIQ Command
            <span className="badge">War Room</span>
          </h1>
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            <span className="live-dot" />
            Live
          </span>
        </header>

        {/* Quick Add */}
        <section className="section">
          <QuickAdd teamMembers={teamMembers} token={token} />
        </section>

        {/* Open Tasks */}
        <section className="section">
          <div className="section-header">
            <h2>Open Tasks</h2>
            <span className="section-count">{openTasks.length} open</span>
          </div>
          <TaskList initialTasks={openTasks} token={token} />
        </section>

        {/* Completed Tasks */}
        <section className="section">
          <CompletedTasks initialTasks={completedTasks} token={token} />
        </section>

        {/* Decisions Log */}
        <section className="section">
          <div className="section-header">
            <h2>Decisions</h2>
            <span className="section-count">{decisions.length} logged</span>
          </div>
          <DecisionLog initialDecisions={decisions} token={token} />
        </section>

        {/* Activity Pulse */}
        <section className="section">
          <div className="section-header">
            <h2>Activity Pulse</h2>
          </div>
          <ActivityPulse initialStats={stats} token={token} />
        </section>

        {/* Footer */}
        <footer style={{
          borderTop: '1px solid var(--border-dim)',
          paddingTop: '1rem',
          paddingBottom: '2rem',
          textAlign: 'center',
          color: 'var(--text-dim)',
          fontSize: '0.75rem',
        }}>
          RevIQ Command · Updates live via Supabase Realtime
        </footer>
      </div>
    </main>
  );
}
