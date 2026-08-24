import { Badge } from './Badge';
import type { TicketSummary } from '../types';

export function TicketList({
  tickets,
  selectedId,
  onSelect,
}: {
  tickets: TicketSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  if (tickets.length === 0) {
    return <div className="section"><p className="notice">No tickets yet.</p></div>;
  }

  return (
    <div>
      <div className="section" style={{ borderBottom: 0, paddingBottom: 0 }}>
        <h2>Tickets</h2>
      </div>
      {tickets.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`ticket ${t.id === selectedId ? 'active' : ''}`}
          onClick={() => onSelect(t.id)}
        >
          <div className="msg">{t.message}</div>
          <div className="meta">
            <Badge status={t.run_status} />
            <span>#{t.id}</span>
            <span>·</span>
            <span>{t.customer_name}</span>
            {Number(t.pending_approvals) > 0 && (
              <span style={{ color: 'var(--amber)', marginLeft: 'auto' }}>needs review</span>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
