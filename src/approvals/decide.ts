import pool from '../db/connection.js';
import type { ApprovalStatus } from '../types.js';

export type DecisionOutcome =
  | { ok: true; approvalId: number; runId: number; ticketId: number; decision: ApprovalStatus }
  | { ok: false; code: 'invalid'; message: string }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'already_decided'; status: string };

export interface DecisionInput {
  approvalId: number;
  decision: 'approved' | 'rejected';
  reviewedBy: string;
  reason?: string | null;
}

/**
 * Record a human verdict on a proposed action.
 *
 * Lives apart from the HTTP layer because this is the state machine that
 * decides whether money is allowed to move — it needs to be exercisable
 * directly, not only through a route handler. The caller maps the outcome onto
 * status codes, and separately enqueues the resume once the verdict is durable.
 */
export async function decideApproval(input: DecisionInput): Promise<DecisionOutcome> {
  const { approvalId, decision, reviewedBy, reason } = input;

  if (!Number.isInteger(approvalId) || approvalId <= 0) {
    return { ok: false, code: 'invalid', message: 'approval id must be a positive integer' };
  }
  if (typeof reviewedBy !== 'string' || reviewedBy.trim() === '') {
    return { ok: false, code: 'invalid', message: 'reviewed_by (non-empty string) is required' };
  }
  // A rejection that doesn't say why is useless to the customer and to the
  // model, which has to explain the outcome in its closing message.
  if (decision === 'rejected' && (typeof reason !== 'string' || reason.trim() === '')) {
    return {
      ok: false,
      code: 'invalid',
      message: 'reason (non-empty string) is required when rejecting',
    };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Conditional on status = 'pending', so the database decides who wins a
    // race. Two reviewers clicking at the same moment, or one double-clicking,
    // produce exactly one state change. Reading first and then updating would
    // leave a window where both callers believe they won -- and each would go
    // on to enqueue a resume for the same approval.
    const { rows } = await client.query<{ run_id: number; ticket_id: number }>(
      `UPDATE approvals a
          SET status = $1, reviewed_by = $2, reason = $3, reviewed_at = NOW()
         FROM agent_runs r
        WHERE a.id = $4 AND a.status = 'pending' AND r.id = a.run_id
    RETURNING a.run_id, r.ticket_id`,
      [decision, reviewedBy, reason ?? null, approvalId],
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      const { rows: existing } = await pool.query<{ status: string }>(
        'SELECT status FROM approvals WHERE id = $1',
        [approvalId],
      );
      if (existing.length === 0) {
        return { ok: false, code: 'not_found' };
      }
      return { ok: false, code: 'already_decided', status: existing[0]!.status };
    }

    const { run_id: runId, ticket_id: ticketId } = rows[0]!;

    await client.query(
      `INSERT INTO audit_log (run_id, event_type, payload) VALUES ($1, $2, $3)`,
      [
        runId,
        decision === 'approved' ? 'approval_granted' : 'approval_rejected',
        JSON.stringify({ approval_id: approvalId, reviewed_by: reviewedBy, reason: reason ?? null }),
      ],
    );

    await client.query('COMMIT');
    return { ok: true, approvalId, runId, ticketId, decision };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
