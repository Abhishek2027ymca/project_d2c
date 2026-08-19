import pool from '../db/connection.js';
import { fail, ok, type ToolResult } from './types.js';
import type { OrderStatus } from '../types.js';

export const RETURN_WINDOW_DAYS = 30;

export interface RefundPolicyResult {
  order_id: number;
  eligible: boolean;
  reasons: string[];
  max_refundable_amount: string;
  order_status: OrderStatus;
  age_days: number;
  return_window_days: number;
}

interface PolicyRow {
  id: number;
  status: OrderStatus;
  amount: string;
  created_at: Date;
}

/**
 * Policy lives here, in code, not in the model's prompt.
 *
 * The agent asks whether a refund is allowed and gets a deterministic answer.
 * If eligibility were left to the model it would vary run to run, and "why was
 * this refund approved?" would have no auditable answer.
 */
export async function checkRefundPolicy(orderId: number): Promise<ToolResult<RefundPolicyResult>> {
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return fail(`Invalid order id: ${orderId}`);
  }

  const { rows } = await pool.query<PolicyRow>(
    'SELECT id, status, amount, created_at FROM orders WHERE id = $1',
    [orderId],
  );

  const order = rows[0];
  if (!order) {
    return fail(`Order ${orderId} not found`);
  }

  const ageDays = Math.floor((Date.now() - order.created_at.getTime()) / 86_400_000);
  const reasons: string[] = [];

  if (order.status === 'refunded') {
    reasons.push('Order has already been refunded');
  }
  if (order.status === 'cancelled') {
    reasons.push('Order was cancelled and was never charged');
  }
  if (order.status === 'active') {
    reasons.push('Order has not shipped yet — cancel it instead of refunding');
  }
  if (ageDays > RETURN_WINDOW_DAYS) {
    reasons.push(`Order is ${ageDays} days old, outside the ${RETURN_WINDOW_DAYS}-day return window`);
  }

  const eligible = reasons.length === 0;
  if (eligible) {
    reasons.push(`Within ${RETURN_WINDOW_DAYS}-day window and order status is '${order.status}'`);
  }

  return ok({
    order_id: order.id,
    eligible,
    reasons,
    max_refundable_amount: order.amount,
    order_status: order.status,
    age_days: ageDays,
    return_window_days: RETURN_WINDOW_DAYS,
  });
}
