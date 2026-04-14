'use client';

import { useState } from 'react';
import { createBrowserClient, TeamMember } from '@/lib/supabase';

interface QuickAddProps {
  teamMembers: TeamMember[];
  token?: string;
}

export default function QuickAdd({ teamMembers, token }: QuickAddProps) {
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState<'success' | 'error' | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const taskTitle = title.trim();
    if (!taskTitle) return;

    setLoading(true);
    const supabase = createBrowserClient();

    const { error } = await supabase.from('tasks').insert({
      title: taskTitle,
      assigned_to: assignee || 'Unassigned',
      status: 'open',
      priority: 'normal',
      created_by: 'Dashboard',
    });

    setLoading(false);

    if (error) {
      console.error('[QuickAdd] Error creating task:', error.message);
      setFlash('error');
      setTimeout(() => setFlash(null), 2500);
    } else {
      setTitle('');
      setAssignee('');
      setFlash('success');
      setTimeout(() => setFlash(null), 2000);
    }
  };

  return (
    <div className="card" style={{ borderColor: flash === 'success' ? 'var(--success)' : flash === 'error' ? 'var(--danger)' : undefined, transition: 'border-color 300ms ease' }}>
      <div className="section-header" style={{ marginBottom: '0.75rem' }}>
        <h2 style={{ fontSize: '0.8125rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
          Quick Add Task
        </h2>
        {flash === 'success' && (
          <span style={{ fontSize: '0.75rem', color: 'var(--success)' }}>✓ Task created</span>
        )}
        {flash === 'error' && (
          <span style={{ fontSize: '0.75rem', color: 'var(--danger)' }}>Failed — check console</span>
        )}
      </div>
      <form className="quick-add-form" onSubmit={handleSubmit}>
        <input
          id="quick-add-input"
          className="input"
          type="text"
          placeholder="What needs to get done?"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSubmit(e as unknown as React.FormEvent); } }}
          autoComplete="off"
          disabled={loading}
          aria-label="Task title"
        />
        <select
          id="quick-add-assignee"
          className="select"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          disabled={loading}
          aria-label="Assign to"
        >
          <option value="">Unassigned</option>
          {teamMembers.map((m) => (
            <option key={m.id} value={m.name}>{m.name}</option>
          ))}
        </select>
        <button
          id="quick-add-submit"
          type="submit"
          className="btn btn-primary"
          disabled={loading || !title.trim()}
          aria-label="Add task"
        >
          {loading ? '…' : 'Add'}
        </button>
      </form>
    </div>
  );
}
