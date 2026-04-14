'use client';

import { useEffect, useState } from 'react';
import { createBrowserClient, subscribeToTasks, Task } from '@/lib/supabase';

interface TaskListProps {
  initialTasks: Task[];
  token?: string;
}

function daysOpen(isoString: string): number {
  const diff = Date.now() - new Date(isoString).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function ageClass(task: Task): string {
  const days = daysOpen(task.created_at);
  if (days >= 7) return 'task-danger';
  if (days >= 3) return 'task-warn';
  return 'task-fresh';
}

function PriorityBadge({ priority }: { priority: Task['priority'] }) {
  return (
    <span className={`badge-priority badge-${priority}`}>
      {priority}
    </span>
  );
}

function TaskItem({ task, onDone }: { task: Task; onDone: (id: string) => void }) {
  const [checking, setChecking] = useState(false);
  const days = daysOpen(task.created_at);
  const ageLabel = days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`;

  const handleCheck = async () => {
    if (checking) return;
    setChecking(true);
    const supabase = createBrowserClient();
    await supabase
      .from('tasks')
      .update({ status: 'done', completed_at: new Date().toISOString() })
      .eq('id', task.id);
    // onDone will be triggered by Realtime subscription
    setChecking(false);
    onDone(task.id);
  };

  return (
    <div className={`task-item card ${ageClass(task)}`} style={{ marginBottom: '0.375rem', borderRadius: 'var(--radius-lg)' }}>
      <label className="checkbox-wrap" htmlFor={`task-${task.id}`} style={{ alignItems: 'flex-start' }}>
        <input
          id={`task-${task.id}`}
          type="checkbox"
          className="checkbox"
          checked={false}
          onChange={handleCheck}
          disabled={checking}
          aria-label={`Mark "${task.title}" as done`}
        />
      </label>
      <div className="task-content">
        <div className="task-title">{task.title}</div>
        <div className="task-meta">
          <PriorityBadge priority={task.priority} />
          <span className="task-age">{ageLabel} open</span>
          {task.description && (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{task.description}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function SkeletonTasks() {
  return (
    <>
      {[1, 2, 3].map((i) => (
        <div key={i} className="skeleton skeleton-line" style={{ marginBottom: '0.5rem' }} />
      ))}
    </>
  );
}

export default function TaskList({ initialTasks, token }: TaskListProps) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [loading, setLoading] = useState(false);

  // Subscribe to Realtime updates
  useEffect(() => {
    const unsubscribe = subscribeToTasks(({ new: newTask, old: oldTask, eventType }) => {
      if (eventType === 'INSERT') {
        if (newTask.status !== 'done') {
          setTasks((prev) => [newTask, ...prev].sort((a, b) =>
            a.assigned_to.localeCompare(b.assigned_to)
          ));
        }
      } else if (eventType === 'UPDATE') {
        if (newTask.status === 'done') {
          // Task was completed — remove from open list
          setTasks((prev) => prev.filter((t) => t.id !== newTask.id));
        } else {
          setTasks((prev) => prev.map((t) => (t.id === newTask.id ? newTask : t)));
        }
      } else if (eventType === 'DELETE') {
        setTasks((prev) => prev.filter((t) => t.id !== oldTask.id));
      }
    });

    return unsubscribe;
  }, []);

  const handleDone = (id: string) => {
    // Optimistic removal
    setTasks((prev) => prev.filter((t) => t.id !== id));
  };

  if (loading) return <SkeletonTasks />;

  // Group by assignee
  const grouped: Record<string, Task[]> = {};
  for (const task of tasks) {
    if (!grouped[task.assigned_to]) grouped[task.assigned_to] = [];
    grouped[task.assigned_to].push(task);
  }

  if (Object.keys(grouped).length === 0) {
    return <div className="empty-state">No open tasks. Enjoy it while it lasts.</div>;
  }

  return (
    <div>
      {Object.entries(grouped).map(([person, personTasks]) => (
        <div key={person} className="person-group">
          <div className="person-label">
            <span>👤</span>
            <span>{person}</span>
            <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>({personTasks.length})</span>
          </div>
          {personTasks.map((task) => (
            <TaskItem key={task.id} task={task} onDone={handleDone} />
          ))}
        </div>
      ))}
    </div>
  );
}
