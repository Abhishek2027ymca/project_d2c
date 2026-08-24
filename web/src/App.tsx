import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { NewTicket } from './components/NewTicket';
import { TicketList } from './components/TicketList';
import { Trace } from './components/Trace';
import type { TicketSummary, Trace as TraceData } from './types';

/** Run states the agent is still moving through, so the view keeps refreshing. */
const LIVE_RUN = new Set(['pending', 'running']);

export function App() {
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [trace, setTrace] = useState<TraceData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Held in a ref so the polling effect can read the current selection without
  // listing it as a dependency -- otherwise every selection change would tear
  // down and rebuild the interval.
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selectedId;

  const refreshTickets = useCallback(async () => {
    try {
      const d = await api.listTickets();
      setTickets(d.tickets);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const refreshTrace = useCallback(async (id: number) => {
    try {
      setTrace(await api.getTrace(id));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { void refreshTickets(); }, [refreshTickets]);

  useEffect(() => {
    if (selectedId === null) { setTrace(null); return; }
    void refreshTrace(selectedId);
  }, [selectedId, refreshTrace]);

  // A run finishes in ~20 seconds, so a 2s poll is enough to watch steps appear
  // without the complexity of SSE or websockets. Polling stops on its own once
  // nothing is in flight: a completed run has nothing left to report, and a run
  // parked at the gate will not move until a human acts.
  useEffect(() => {
    const timer = setInterval(() => {
      const anyLive = tickets.some((t) => t.run_status && LIVE_RUN.has(t.run_status));
      const traceLive = trace?.run && LIVE_RUN.has(trace.run.status);

      if (anyLive || traceLive) {
        void refreshTickets();
        if (selectedRef.current !== null) void refreshTrace(selectedRef.current);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [tickets, trace, refreshTickets, refreshTrace]);

  const onCreated = useCallback(
    async (ticketId: number) => {
      setSelectedId(ticketId);
      await refreshTickets();
    },
    [refreshTickets],
  );

  // After a verdict the run restarts, so both views need to catch up at once.
  const onDecided = useCallback(async () => {
    await Promise.all([
      refreshTickets(),
      selectedId !== null ? refreshTrace(selectedId) : Promise.resolve(),
    ]);
  }, [refreshTickets, refreshTrace, selectedId]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <h1>Support-Ops Agent</h1>
          <p>Agent proposes. A human approves the money.</p>
        </div>
        <NewTicket onCreated={onCreated} />
        <TicketList tickets={tickets} selectedId={selectedId} onSelect={setSelectedId} />
      </aside>

      <main className="main">
        {error && <div className="error">{error}</div>}
        {trace ? (
          <Trace trace={trace} onDecided={onDecided} />
        ) : (
          <p className="empty">Select a ticket, or submit one, to watch the agent work.</p>
        )}
      </main>
    </div>
  );
}
