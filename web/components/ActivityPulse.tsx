'use client';

import { useEffect, useState } from 'react';
import { subscribeToTasks, subscribeToDecisions, Stats } from '@/lib/supabase';

interface ActivityPulseProps {
  initialStats: Stats;
  token?: string;
}

interface StatCardProps {
  value: number;
  label: string;
  id: string;
}

function StatCard({ value, label, id }: StatCardProps) {
  const [displayValue, setDisplayValue] = useState(value);
  const [bump, setBump] = useState(false);

  useEffect(() => {
    setDisplayValue(value);
  }, [value]);

  // Animate on change
  const animateBump = () => {
    setBump(true);
    setTimeout(() => setBump(false), 400);
  };

  return (
    <div
      id={id}
      className="stat-card"
      style={{
        transform: bump ? 'scale(1.03)' : 'scale(1)',
        transition: 'transform 300ms ease',
      }}
    >
      <div className="stat-value">{displayValue}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export default function ActivityPulse({ initialStats }: ActivityPulseProps) {
  const [stats, setStats] = useState<Stats>(initialStats);

  // Reactively update stats as new tasks/decisions arrive
  useEffect(() => {
    const unsubTasks = subscribeToTasks(({ new: newTask, eventType }) => {
      if (eventType === 'INSERT') {
        setStats((prev) => ({
          ...prev,
          tasksCreatedThisWeek: prev.tasksCreatedThisWeek + 1,
        }));
      } else if (eventType === 'UPDATE' && newTask.status === 'done') {
        setStats((prev) => ({
          ...prev,
          tasksCompletedThisWeek: prev.tasksCompletedThisWeek + 1,
        }));
      }
    });

    const unsubDecisions = subscribeToDecisions(({ eventType }) => {
      if (eventType === 'INSERT') {
        setStats((prev) => ({
          ...prev,
          decisionsThisWeek: prev.decisionsThisWeek + 1,
        }));
      }
    });

    return () => {
      unsubTasks();
      unsubDecisions();
    };
  }, []);

  return (
    <div className="stat-grid" id="activity-pulse">
      <StatCard
        id="stat-messages-today"
        value={stats.messagesToday}
        label="Messages today"
      />
      <StatCard
        id="stat-tasks-created"
        value={stats.tasksCreatedThisWeek}
        label="Tasks created this week"
      />
      <StatCard
        id="stat-tasks-done"
        value={stats.tasksCompletedThisWeek}
        label="Completed this week"
      />
      <StatCard
        id="stat-decisions"
        value={stats.decisionsThisWeek}
        label="Decisions this week"
      />
    </div>
  );
}
