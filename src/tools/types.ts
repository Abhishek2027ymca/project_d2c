/**
 * Every tool returns this shape rather than throwing.
 *
 * A thrown exception would abort the agent loop; a failed tool result gets fed
 * back to the model, which can then reason about the failure ("order not found,
 * so I should ask the customer to confirm the order number") instead of the run
 * dying. Tool failure is information, not an outage.
 */
export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

export function fail<T = never>(error: string): ToolResult<T> {
  return { ok: false, error };
}
