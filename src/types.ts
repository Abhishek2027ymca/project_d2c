/**
 * Domain types. These mirror the DB schema in src/db/migrate.ts.
 * Keeping them in one place means a schema change surfaces as a compile error
 * everywhere the shape is used, instead of an undefined at runtime.
 */

export type OrderStatus = 'active' | 'shipped' | 'delivered' | 'refunded' | 'cancelled';
export type TicketStatus = 'open' | 'processing' | 'awaiting_approval' | 'resolved' | 'rejected';
export type RunStatus = 'pending' | 'running' | 'awaiting_approval' | 'completed' | 'failed';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Customer {
  id: number;
  name: string;
  email: string;
  created_at: Date;
}

export interface Order {
  id: number;
  customer_id: number;
  status: OrderStatus;
  amount: string; // pg returns DECIMAL as string to avoid float precision loss
  created_at: Date;
}

export interface Ticket {
  id: number;
  customer_id: number;
  order_id: number | null;
  message: string;
  status: TicketStatus;
  created_at: Date;
}

export interface AgentRun {
  id: number;
  ticket_id: number;
  status: RunStatus;
  started_at: Date;
  completed_at: Date | null;
}

export interface AgentStep {
  id: number;
  run_id: number;
  step_order: number;
  tool_called: string | null;
  input: unknown;
  output: unknown;
  reasoning: string | null;
  timestamp: Date;
}

export interface Approval {
  id: number;
  run_id: number;
  proposed_action: string;
  status: ApprovalStatus;
  reviewed_by: string | null;
  reviewed_at: Date | null;
}

export interface AuditLogEntry {
  id: number;
  run_id: number;
  event_type: string;
  payload: unknown;
  timestamp: Date;
}
