import type { Customer, Order, PendingApproval, TicketSummary, Trace } from './types';

// In dev the dashboard runs on Vite (5173) and the API on 3000, so calls go
// through Vite's proxy at /api. In production Express serves this bundle
// itself, so the API is already same-origin at the root.
const BASE = import.meta.env.DEV ? '/api' : '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

  // Errors come back as JSON with an `error` field. Surfacing that message
  // matters here -- "Approval 3 was already approved" is the whole point of the
  // 409, and a generic "request failed" would throw away what happened.
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Non-JSON error body; the status line is all we have.
    }
    throw new Error(message);
  }

  return res.json() as Promise<T>;
}

export const api = {
  listTickets: () => request<{ tickets: TicketSummary[] }>('/tickets'),

  getTrace: (ticketId: number) => request<Trace>(`/tickets/${ticketId}/trace`),

  listApprovals: () => request<{ pending: PendingApproval[] }>('/approvals'),

  demoData: () => request<{ customers: Customer[]; orders: Order[] }>('/demo-data'),

  createTicket: (body: { customer_id: number; order_id: number | null; message: string }) =>
    request<{ ticket_id: number; run_id: number; status: string }>('/tickets', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  decide: (approvalId: number, decision: 'approve' | 'reject', reviewed_by: string, reason: string) =>
    request<{ approval_id: number; status: string; run_id: number }>(
      `/approvals/${approvalId}/${decision}`,
      { method: 'POST', body: JSON.stringify({ reviewed_by, reason }) },
    ),
};
