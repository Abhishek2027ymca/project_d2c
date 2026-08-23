import pool from '../db/connection.js';
import { fail, ok, type ToolResult } from './types.js';
import { checkRefundPolicy } from './checkRefundPolicy.js';

export interface IssueRefundInput {
  orderId: number;
  amount: number;
  reason: string;
  runId: number;
  /**
   * Stable identifier for this *logical* refund, chosen by the caller. Two calls
   * carrying the same key are the same refund, however many times they are
   * retried. Required rather than optional: a caller that has not thought about
   * what makes its refund unique cannot move money here.
   */
  idempotencyKey: string;
}

export interface IssueRefundResult {
  order_id: number;
  refunded_amount: string;
  reason: string;
  refunded_at: string;
}

/**
 * The money-moving action. Three properties matter more than the happy path:
 *
 * 1. Policy is re-checked here, not trusted from the model's earlier tool call.
 *    The model could hallucinate eligibility, or state could have changed between
 *    the check and the execution. The gate that matters is the one at the point
 *    of execution.
 *
 * 2. The refund is claimed against a UNIQUE idempotency key before anything is
 *    paid out. A retry of an already-completed refund returns the *original
 *    result as a success* rather than an error — which is the behaviour a caller
 *    retrying after a timeout actually needs, and which the conditional UPDATE
 *    below cannot express on its own (it can only say "no rows matched").
 *
 * 3. The UPDATE is still conditional on the order not already being refunded.
 *    That guards the case the key cannot see: a *different* logical refund
 *    racing for the same order. Two layers, guarding two different mistakes.
 */
export async function issueRefund(input: IssueRefundInput): Promise<ToolResult<IssueRefundResult>> {
  const { orderId, amount, reason, runId, idempotencyKey } = input;

  // Argument sanity only. Anything that depends on database state is checked
  // after the idempotency key is claimed, so a replay of a finished refund is
  // never re-judged against state its own execution changed.
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return fail(`Invalid order id: ${orderId}`);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return fail(`Refund amount must be a positive number, got: ${amount}`);
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    return fail('A refund reason is required');
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    return fail('An idempotency key is required to issue a refund');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Claim the key. ON CONFLICT DO UPDATE rather than DO NOTHING is deliberate:
    // DO NOTHING returns no row and takes no lock, so a concurrent duplicate
    // would sail past and read a result the other transaction has not committed
    // yet. Assigning the column to itself is a no-op write that takes the row
    // lock, so the loser blocks until the winner commits and then sees its result.
    const claim = await client.query<{ id: number; result: IssueRefundResult | null }>(
      `INSERT INTO refunds (idempotency_key, run_id, order_id, amount, reason)
            VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key)
       DO UPDATE SET idempotency_key = refunds.idempotency_key
         RETURNING id, result`,
      [idempotencyKey, runId, orderId, amount, reason],
    );

    const claimed = claim.rows[0]!;

    // A committed result means this exact refund already paid out. Return it as
    // a success — re-running policy here would (correctly) report the order as
    // already refunded and turn a safe retry into a spurious failure.
    if (claimed.result !== null) {
      await client.query('COMMIT');
      return ok(claimed.result);
    }

    const policy = await checkRefundPolicy(orderId);
    if (!policy.ok) {
      await client.query('ROLLBACK');
      return fail(policy.error);
    }
    if (!policy.data.eligible) {
      await client.query('ROLLBACK');
      return fail(`Refund denied by policy: ${policy.data.reasons.join('; ')}`);
    }
    if (amount > Number(policy.data.max_refundable_amount)) {
      await client.query('ROLLBACK');
      return fail(
        `Refund amount ${amount} exceeds order total ${policy.data.max_refundable_amount}`,
      );
    }

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

    const result: IssueRefundResult = {
      order_id: orderId,
      refunded_amount: amount.toFixed(2),
      reason,
      refunded_at: new Date().toISOString(),
    };

    // Recording the result is what marks this key as finished. Same transaction
    // as the payout, so the two can never disagree.
    await client.query(`UPDATE refunds SET result = $1 WHERE id = $2`, [
      JSON.stringify(result),
      claimed.id,
    ]);

    await client.query(
      `INSERT INTO audit_log (run_id, event_type, payload)
       VALUES ($1, 'refund_issued', $2)`,
      [
        runId,
        JSON.stringify({
          order_id: orderId,
          amount,
          reason,
          idempotency_key: idempotencyKey,
          refunded_at: result.refunded_at,
        }),
      ],
    );

    await client.query('COMMIT');
    return ok(result);
  } catch (err) {
    await client.query('ROLLBACK');
    return fail(`Refund failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    client.release();
  }
}
