import pool from '../db/connection.js';
import { fail, ok, type ToolResult } from './types.js';
import type { OrderStatus } from '../types.js';

export interface OrderLookupResult {
  order_id: number;
  status: OrderStatus;
  amount: string;
  created_at: string;
  age_days: number;
  customer: { id: number; name: string; email: string };
}

interface OrderRow {
  id: number;
  status: OrderStatus;
  amount: string;
  created_at: Date;
  customer_id: number;
  customer_name: string;
  customer_email: string;
}

export async function lookupOrder(orderId: number): Promise<ToolResult<OrderLookupResult>> {
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return fail(`Invalid order id: ${orderId}`);
  }

  const { rows } = await pool.query<OrderRow>(
    `SELECT o.id, o.status, o.amount, o.created_at,
            c.id AS customer_id, c.name AS customer_name, c.email AS customer_email
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
      WHERE o.id = $1`,
    [orderId],
  );

  const row = rows[0];
  if (!row) {
    return fail(`Order ${orderId} not found`);
  }

  const ageDays = Math.floor((Date.now() - row.created_at.getTime()) / 86_400_000);

  return ok({
    order_id: row.id,
    status: row.status,
    amount: row.amount,
    created_at: row.created_at.toISOString(),
    age_days: ageDays,
    customer: { id: row.customer_id, name: row.customer_name, email: row.customer_email },
  });
}
