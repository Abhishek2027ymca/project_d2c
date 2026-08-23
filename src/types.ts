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
  /**
   * The model conversation, persisted when a run pauses at the approval gate so
   * a different worker process can pick it up later and continue mid-thought.
   * NULL for runs that never paused.
   */
  conversation_state: unknown | null;
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

/** What the agent wants to do, captured verbatim at the moment it was intercepted. */
export interface ProposedAction {
  tool: string;
  args: Record<string, unknown>;
  /** Gemini's id for the intercepted call, echoed back when the run resumes. */
  call_id?: string;
}

export interface Approval {
  id: number;
  run_id: number;
  proposed_action: ProposedAction;
  status: ApprovalStatus;
  /** Why the reviewer approved or rejected — surfaced to the model on resume. */
  reason: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
}

/**
 * One executed refund. `idempotency_key` is unique, so a retry of the same
 * logical refund collides rather than paying twice; `result` is NULL until the
 * money actually moved, which distinguishes a crashed attempt from a finished one.
 */
export interface Refund {
  id: number;
  idempotency_key: string;
  run_id: number;
  order_id: number;
  amount: string; // DECIMAL — string for the same reason as Order.amount
  reason: string;
  result: unknown | null;
  created_at: Date;
}

export interface AuditLogEntry {
  id: number;
  run_id: number;
  event_type: string;
  payload: unknown;
  timestamp: Date;
}
