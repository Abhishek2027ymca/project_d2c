import { lookupOrder } from '../tools/lookupOrder.js';
import { checkRefundPolicy } from '../tools/checkRefundPolicy.js';
import { issueRefund } from '../tools/issueRefund.js';
import { fail, type ToolResult } from '../tools/types.js';

export interface ExecuteToolContext {
  runId: number;
  /**
   * Required before a money-moving tool will run. Supplied by the approval
   * resume path (derived from the approval id), never invented here — the key
   * has to be stable across retries, and only the caller knows what "the same
   * refund" means in its context.
   */
  idempotencyKey?: string;
}

/**
 * Maps a tool name from the model onto the real function.
 *
 * Inputs are re-validated here even though the schemas are `strict`. The schema
 * is a contract with the model; this is the boundary where untrusted input
 * enters real code, and the two are not the same trust level.
 */
export async function executeTool(
  name: string,
  input: unknown,
  ctx: ExecuteToolContext,
): Promise<ToolResult<unknown>> {
  const args = (input ?? {}) as Record<string, unknown>;

  switch (name) {
    case 'lookup_order':
      return lookupOrder(Number(args.order_id));

    case 'check_refund_policy':
      return checkRefundPolicy(Number(args.order_id));

    case 'issue_refund': {
      // Reaching here without a key means something bypassed the approval gate.
      // Refuse rather than mint one, which would silently defeat idempotency.
      if (!ctx.idempotencyKey) {
        return fail('issue_refund requires an approved action with an idempotency key');
      }
      return issueRefund({
        orderId: Number(args.order_id),
        amount: Number(args.amount),
        reason: String(args.reason ?? ''),
        runId: ctx.runId,
        idempotencyKey: ctx.idempotencyKey,
      });
    }

    default:
      return fail(`Unknown tool: ${name}`);
  }
}
