/**
 * Manual smoke test for the three agent tools.
 *
 * These are the decisions that actually move money, so they are verified
 * directly against the database — no LLM involved. If the agent loop later
 * misbehaves, this script tells you whether the tools or the model is at
 * fault, which is the first question worth answering.
 *
 * Run with:  npm run verify:tools
 * Destructive: issues real refunds against seeded orders. Re-seed afterwards
 * (the script reminds you at the end).
 */
import pool from '../db/connection.js';
import { lookupOrder } from '../tools/lookupOrder.js';
import { checkRefundPolicy } from '../tools/checkRefundPolicy.js';
import { issueRefund } from '../tools/issueRefund.js';
import type { ToolResult } from '../tools/types.js';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function summarize(result: ToolResult<unknown>): string {
  return result.ok ? 'ok' : `error: ${result.error}`;
}

/** issueRefund writes to audit_log, which has a FK on agent_runs — so a run must exist. */
async function createScratchRun(): Promise<{ runId: number; ticketId: number }> {
  const { rows: ticketRows } = await pool.query<{ id: number }>(
    `INSERT INTO tickets (customer_id, order_id, message)
     SELECT id, NULL, '[verifyTools] scratch ticket' FROM customers ORDER BY id LIMIT 1
     RETURNING id`,
  );
  const ticketId = ticketRows[0]!.id;

  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO agent_runs (ticket_id, status) VALUES ($1, 'running') RETURNING id`,
    [ticketId],
  );
  return { runId: runRows[0]!.id, ticketId };
}

async function main(): Promise<void> {
  const { runId, ticketId } = await createScratchRun();
  console.log(`Using scratch run ${runId} (ticket ${ticketId})\n`);

  // Pick real orders by status so the script survives re-seeding with new ids.
  const { rows: orders } = await pool.query<{ id: number; status: string; amount: string }>(
    `SELECT DISTINCT ON (status) id, status, amount FROM orders ORDER BY status, id`,
  );
  const byStatus = new Map(orders.map((o) => [o.status, o]));

  const delivered = byStatus.get('delivered');
  const refunded = byStatus.get('refunded');
  const cancelled = byStatus.get('cancelled');
  const active = byStatus.get('active');

  if (!delivered || !refunded || !cancelled || !active) {
    console.error('Seed data is missing an expected order status. Run: npm run db:seed');
    process.exitCode = 1;
    return;
  }

  console.log('lookup_order');
  const found = await lookupOrder(delivered.id);
  check('finds a real order', found.ok, summarize(found));
  check(
    'returns amount as a string (no float rounding on money)',
    found.ok && typeof found.data.amount === 'string',
  );
  const missing = await lookupOrder(999_999);
  check('reports a missing order as a failed result, not a throw', !missing.ok);
  const badId = await lookupOrder(-1);
  check('rejects a negative id', !badId.ok);

  console.log('\ncheck_refund_policy');
  const okPolicy = await checkRefundPolicy(delivered.id);
  check('delivered order is eligible', okPolicy.ok && okPolicy.data.eligible, summarize(okPolicy));
  const refundedPolicy = await checkRefundPolicy(refunded.id);
  check(
    'already-refunded order is ineligible',
    refundedPolicy.ok && !refundedPolicy.data.eligible,
    summarize(refundedPolicy),
  );
  const cancelledPolicy = await checkRefundPolicy(cancelled.id);
  check(
    'cancelled order is ineligible',
    cancelledPolicy.ok && !cancelledPolicy.data.eligible,
    summarize(cancelledPolicy),
  );
  const activePolicy = await checkRefundPolicy(active.id);
  check(
    'unshipped order is ineligible',
    activePolicy.ok && !activePolicy.data.eligible,
    summarize(activePolicy),
  );

  console.log('\nissue_refund');
  const amount = Number(delivered.amount);

  // Keys are scoped to this scratch run so a re-run of the script performs a
  // genuinely new refund instead of replaying the previous run's stored result.
  const key = (suffix: string) => `verify-${runId}-${suffix}`;

  const overAmount = await issueRefund({
    orderId: delivered.id,
    amount: amount + 100,
    reason: 'over-refund attempt',
    runId,
    idempotencyKey: key('over'),
  });
  check('refuses an amount above the order total', !overAmount.ok, summarize(overAmount));

  const negative = await issueRefund({
    orderId: delivered.id,
    amount: -5,
    reason: 'negative amount',
    runId,
    idempotencyKey: key('negative'),
  });
  check('refuses a negative amount', !negative.ok, summarize(negative));

  const noReason = await issueRefund({
    orderId: delivered.id,
    amount,
    reason: '   ',
    runId,
    idempotencyKey: key('no-reason'),
  });
  check('refuses a blank reason', !noReason.ok, summarize(noReason));

  const noKey = await issueRefund({
    orderId: delivered.id,
    amount,
    reason: 'missing idempotency key',
    runId,
    idempotencyKey: '',
  });
  check('refuses to move money without an idempotency key', !noKey.ok, summarize(noKey));

  const ineligible = await issueRefund({
    orderId: cancelled.id,
    amount: 1,
    reason: 'should be blocked by policy',
    runId,
    idempotencyKey: key('ineligible'),
  });
  check(
    're-checks policy at execution time and blocks an ineligible order',
    !ineligible.ok,
    summarize(ineligible),
  );

  const first = await issueRefund({
    orderId: delivered.id,
    amount,
    reason: 'verifyTools: legitimate refund',
    runId,
    idempotencyKey: key('legit'),
  });
  check('issues a valid refund', first.ok, summarize(first));

  // The property idempotency keys add over the conditional UPDATE: replaying the
  // *same* logical refund is a success that returns the original result, not an
  // error. A caller retrying after a timeout needs to hear "this already
  // happened, here is what happened" -- not "denied".
  const replay = await issueRefund({
    orderId: delivered.id,
    amount,
    reason: 'verifyTools: legitimate refund',
    runId,
    idempotencyKey: key('legit'),
  });
  check('replaying the same idempotency key succeeds', replay.ok, summarize(replay));
  // Compared field by field rather than by JSON.stringify: JSONB is not JSON.
  // Postgres normalizes object key order on storage (shortest key first, then
  // bytewise), so the round-tripped result is value-identical but serializes in
  // a different order than the object that went in.
  check(
    'the replay returns the original result, not a fresh one',
    first.ok &&
      replay.ok &&
      first.data.order_id === replay.data.order_id &&
      first.data.refunded_amount === replay.data.refunded_amount &&
      first.data.reason === replay.data.reason &&
      first.data.refunded_at === replay.data.refunded_at,
    `first=${JSON.stringify(first.ok && first.data)} replay=${JSON.stringify(replay.ok && replay.data)}`,
  );

  // A *different* logical refund against an already-refunded order is a genuine
  // error. This is the case an idempotency key cannot see, and the reason the
  // conditional UPDATE stays in place alongside it.
  const second = await issueRefund({
    orderId: delivered.id,
    amount,
    reason: 'verifyTools: duplicate attempt',
    runId,
    idempotencyKey: key('duplicate'),
  });
  check(
    'a different refund on an already-refunded order is rejected',
    !second.ok,
    summarize(second),
  );

  const { rows: auditRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM audit_log
      WHERE run_id = $1 AND event_type = 'refund_issued'`,
    [runId],
  );
  check(
    'exactly one refund_issued audit entry was written',
    auditRows[0]!.count === '1',
    `found ${auditRows[0]!.count}`,
  );

  const { rows: paidRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM refunds WHERE run_id = $1 AND result IS NOT NULL`,
    [runId],
  );
  check(
    'exactly one refund row actually paid out',
    paidRows[0]!.count === '1',
    `found ${paidRows[0]!.count}`,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
  console.log('\nThis script mutated seeded data. Restore it with: npm run db:seed');
}

try {
  await main();
} finally {
  await pool.end();
}
