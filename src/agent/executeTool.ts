import { lookupOrder } from '../tools/lookupOrder.js';
import { checkRefundPolicy } from '../tools/checkRefundPolicy.js';
import { issueRefund } from '../tools/issueRefund.js';
import { fail, type ToolResult } from '../tools/types.js';

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
  runId: number,
): Promise<ToolResult<unknown>> {
  const args = (input ?? {}) as Record<string, unknown>;

  switch (name) {
    case 'lookup_order':
      return lookupOrder(Number(args.order_id));

    case 'check_refund_policy':
      return checkRefundPolicy(Number(args.order_id));

    case 'issue_refund':
      return issueRefund({
        orderId: Number(args.order_id),
        amount: Number(args.amount),
        reason: String(args.reason ?? ''),
        runId,
      });

    default:
      return fail(`Unknown tool: ${name}`);
  }
}
