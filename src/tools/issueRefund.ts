import pool from '../db/connection.js';
import { fail, ok, type ToolResult } from './types.js';
import { checkRefundPolicy } from './checkRefundPolicy.js';

export interface IssueRefundInput {
  orderId: number;
  amount: number;
  reason: string;
  runId: number;
}

export interface IssueRefundResult {
  order_id: number;
  refunded_amount: string;
  reason: string;
  refunded_at: string;
}

/**
 * The money-moving action. Two properties matter more than the happy path:
 *
 * 1. Policy is re-checked here, not trusted from the model's earlier tool call.
 *    The model could hallucinate eligibility, or state could have changed between
 *    the check and the execution. The gate that matters is the one at the point
 *    of execution.
 *
 * 2. The UPDATE is conditional on the order not already being refunded, so two
 *    concurrent calls cannot both succeed — the second matches zero rows. This
 *    is the database enforcing single-execution rather than the application
 *    hoping for it. (Week 3 adds explicit idempotency keys on top.)
 */
export async function issueRefund(input: IssueRefundInput): Promise<ToolResult<IssueRefundResult>> {
  const { orderId, amount, reason, runId } = input;

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return fail(`Invalid order id: ${orderId}`);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return fail(`Refund amount must be a positive number, got: ${amount}`);
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    return fail('A refund reason is required');
  }

  const policy = await checkRefundPolicy(orderId);
  if (!policy.ok) {
    return fail(policy.error);
  }
  if (!policy.data.eligible) {
    return fail(`Refund denied by policy: ${policy.data.reasons.join('; ')}`);
  }
  if (amount > Number(policy.data.max_refundable_amount)) {
    return fail(
      `Refund amount ${amount} exceeds order total ${policy.data.max_refundable_amount}`,
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{ id: number; amount: string }>(
      `UPDATE orders
          SET status = 'refunded'
        WHERE id = $1 AND status <> 'refunded'
        RETURNING id, amount`,
      [orderId],
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return fail(`Order ${orderId} was already refunded by another process`);
    }

    const refundedAt = new Date().toISOString();

    await client.query(
      `INSERT INTO audit_log (run_id, event_type, payload)
       VALUES ($1, 'refund_issued', $2)`,
      [runId, JSON.stringify({ order_id: orderId, amount, reason, refunded_at: refundedAt })],
    );

    await client.query('COMMIT');

    return ok({
      order_id: orderId,
      refunded_amount: amount.toFixed(2),
      reason,
      refunded_at: refundedAt,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return fail(`Refund failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    client.release();
  }
}
