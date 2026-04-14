'use client';

import { useEffect, useState } from 'react';
import { subscribeToDecisions, Decision } from '@/lib/supabase';

interface DecisionLogProps {
  initialDecisions: Decision[];
  token?: string;
}

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function DecisionItem({ decision }: { decision: Decision }) {
  const [expanded, setExpanded] = useState(false);
  const hasContext = !!decision.context;
  const contextPreview = decision.context && decision.context.length > 100
    ? decision.context.slice(0, 100) + '…'
    : decision.context;

  return (
    <div className="decision-item" id={`decision-${decision.id}`}>
      <div className="decision-text">{decision.decision}</div>
      <div className="decision-meta">
        <span>{decision.decided_by}</span>
        <span>·</span>
        <span>{formatDate(decision.created_at)}</span>
      </div>
      {hasContext && (
        <>
          <div className="decision-context">
            {expanded ? decision.context : contextPreview}
          </div>
          {decision.context && decision.context.length > 100 && (
            <button
              className="btn btn-ghost"
              onClick={() => setExpanded(!expanded)}
              style={{ marginTop: '0.375rem', fontSize: '0.75rem', padding: '0.25rem 0.625rem' }}
              aria-label={expanded ? 'Show less' : 'Show more context'}
            >
              {expanded ? 'Less' : 'More'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function SkeletonDecisions() {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {[1, 2, 3].map((i) => (
        <div key={i} style={{ padding: '0.875rem 1rem', borderBottom: '1px solid var(--border-dim)' }}>
          <div className="skeleton skeleton-text" />
          <div className="skeleton skeleton-text-sm" />
        </div>
      ))}
    </div>
  );
}

export default function DecisionLog({ initialDecisions }: DecisionLogProps) {
  const [decisions, setDecisions] = useState<Decision[]>(initialDecisions);

  // Subscribe to new decisions in real time
  useEffect(() => {
    const unsubscribe = subscribeToDecisions(({ new: newDecision, eventType }) => {
      if (eventType === 'INSERT') {
        setDecisions((prev) => [newDecision, ...prev]);
      }
    });

    return unsubscribe;
  }, []);

  if (!decisions.length) {
    return <div className="empty-state">No decisions logged yet. Use /decide in the Telegram group.</div>;
  }

  return (
    <div className="card scroll-area" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="scroll-area" id="decision-log-scroll">
        {decisions.map((d) => (
          <DecisionItem key={d.id} decision={d} />
        ))}
      </div>
    </div>
  );
}
