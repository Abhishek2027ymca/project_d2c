// Mirrors the API's response shapes. Deliberately hand-written rather than
// imported from ../../src: the backend types describe database rows, and what
// crosses the wire is JSON -- dates arrive as strings, and DECIMAL columns as
// strings too. Pretending otherwise is how a Date method gets called on a string.

export type RunStatus = 'pending' | 'running' | 'awaiting_approval' | 'completed' | 'failed';
export type TicketStatus = 'open' | 'processing' | 'awaiting_approval' | 'resolved' | 'rejected';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface TicketSummary {
  id: number;
  customer_id: number;
  customer_name: string;
  order_id: number | null;
  message: string;
  status: TicketStatus;
  created_at: string;
  run_id: number | null;
  run_status: RunStatus | null;
  started_at: string | null;
  completed_at: string | null;
  step_count: string;
  pending_approvals: string;
}

export interface AgentStep {
  id: number;
  run_id: number;
  step_order: number;
  tool_called: string | null;
  input: unknown;
  output: unknown;
  reasoning: string | null;
  timestamp: string;
}

export interface ProposedAction {
  tool: string;
  args: Record<string, unknown>;
  call_id?: string;
}

export interface Approval {
  id: number;
  run_id: number;
  proposed_action: ProposedAction;
  status: ApprovalStatus;
  reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export interface Trace {
  ticket: {
    id: number;
    customer_id: number;
    order_id: number | null;
    message: string;
    status: TicketStatus;
    created_at: string;
  };
  run: { id: number; status: RunStatus; started_at: string; completed_at: string | null } | null;
  steps: AgentStep[];
  approvals: Approval[];
}

export interface PendingApproval extends Approval {
  ticket_id: number;
  ticket_message: string;
  customer_id: number;
}

export interface Customer {
  id: number;
  name: string;
  email: string;
}

export interface Order {
  id: number;
  customer_id: number;
  status: string;
  amount: string; // DECIMAL arrives as a string; never parse it for display maths
  created_at: string;
}
