import { useState } from 'react';
import { api } from '../api';
import type { Approval } from '../types';

/**
 * The human-in-the-loop control. Shows exactly what the agent proposed -- the
 * stored action, not a re-derived summary -- because this is what will execute
 * verbatim if approved.
 */
export function ApprovalCard({ approval, onDecided }: { approval: Approval; onDecided: () => void }) {
  const [reviewer, setReviewer] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const args = approval.proposed_action.args as { order_id?: number; amount?: number; reason?: string };

  async function decide(decision: 'approve' | 'reject') {
    setBusy(decision);
    setError(null);
    try {
      await api.decide(approval.id, decision, reviewer.trim(), reason.trim());
      onDecided();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const canAct = reviewer.trim() !== '';
  // The API requires a reason to reject; mirrored here so the button explains
  // itself rather than the user discovering the rule via a 400.
  const canReject = canAct && reason.trim() !== '';

  return (
    <div className="approval">
      <h3>Waiting for your approval</h3>
      <p className="sub">
        The agent stopped before executing this. Nothing has moved yet.
      </p>

      <dl className="action-grid">
        <dt>action</dt>
        <dd>{approval.proposed_action.tool}</dd>
        {args.order_id !== undefined && (<><dt>order</dt><dd>#{args.order_id}</dd></>)}
        {args.amount !== undefined && (
          <><dt>amount</dt><dd className="amount">${Number(args.amount).toFixed(2)}</dd></>
        )}
        {args.reason && (<><dt>reason</dt><dd>{args.reason}</dd></>)}
      </dl>

      <div className="field">
        <label htmlFor="reviewer">Your name</label>
        <input
          id="reviewer"
          value={reviewer}
          placeholder="abhishek"
          onChange={(e) => setReviewer(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="reason">Reason {'(required to reject)'}</label>
        <input
          id="reason"
          value={reason}
          placeholder="Defect confirmed"
          onChange={(e) => setReason(e.target.value)}
        />
      </div>

      {error && <div className="error">{error}</div>}

      <div className="row">
        <button className="primary" disabled={!canAct || busy !== null} onClick={() => decide('approve')}>
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <button className="danger" disabled={!canReject || busy !== null} onClick={() => decide('reject')}>
          {busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
      </div>
    </div>
  );
}
