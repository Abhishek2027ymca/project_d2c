const LIVE = new Set(['running', 'processing', 'pending']);

/** Status pill. Pulses while the state is one the agent is actively moving through. */
export function Badge({ status }: { status: string | null }) {
  if (!status) return <span className="badge open">no run</span>;
  return (
    <span className={`badge ${status}`}>
      <span className={`dot ${LIVE.has(status) ? 'live' : ''}`} />
      {status.replace(/_/g, ' ')}
    </span>
  );
}
