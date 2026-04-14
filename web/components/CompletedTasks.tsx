'use client';

import { useEffect, useState } from 'react';
import { subscribeToTasks, Task } from '@/lib/supabase';

interface CompletedTasksProps {
  initialTasks: Task[];
  token?: string;
}

function formatDate(isoString: string | null): string {
  if (!isoString) return '';
  return new Date(isoString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function timeToComplete(created: string, completed: string | null): string {
  if (!completed) return '';
  const diff = new Date(completed).getTime() - new Date(created).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  return '< 1h';
}

export default function CompletedTasks({ initialTasks }: CompletedTasksProps) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);

  // Listen for newly completed tasks via Realtime
  useEffect(() => {
    const unsubscribe = subscribeToTasks(({ new: newTask, eventType }) => {
      if (eventType === 'UPDATE' && newTask.status === 'done') {
        setTasks((prev) => {
          const updated = [newTask, ...prev.filter((t) => t.id !== newTask.id)];
          return updated.slice(0, 10); // keep last 10
        });
      }
    });

    return unsubscribe;
  }, []);

  return (
    <details id="completed-tasks-section">
      <summary style={{ outline: 'none' }}>
        <div className="card" style={{ cursor: 'pointer', userSelect: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.8125rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
                Recently Completed
              </span>
              {tasks.length > 0 && (
                <span className="badge-priority badge-normal" style={{ background: 'var(--success-bg)', color: 'var(--success)' }}>
                  {tasks.length}
                </span>
              )}
            </div>
            <span className="chevron" style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>▶</span>
          </div>
        </div>
      </summary>

      <div className="card" style={{ marginTop: '0.5rem', padding: 0, overflow: 'hidden' }}>
        {tasks.length === 0 ? (
          <div className="empty-state" style={{ border: 'none' }}>No completed tasks yet.</div>
        ) : (
          <>
            {tasks.map((task) => (
              <div key={task.id} className="completed-item">
                <span className="completed-check" aria-hidden="true">✓</span>
                <div className="completed-content">
                  <div className="completed-title">{task.title}</div>
                  <div className="completed-meta">
                    {task.assigned_to} · Completed {formatDate(task.completed_at)}
                    {task.completed_at && (
                      <> · took {timeToComplete(task.created_at, task.completed_at)}</>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </details>
  );
}
