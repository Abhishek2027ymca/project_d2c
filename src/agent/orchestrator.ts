import { GoogleGenAI, type Content, type Part } from '@google/genai';
import pool from '../db/connection.js';
import { executeTool } from './executeTool.js';
import { MONEY_MOVING_TOOLS, TOOL_DECLARATIONS } from './toolSchemas.js';
import type { ProposedAction, RunStatus, Ticket } from '../types.js';

/**
 * Hard cap on tool-call round trips per run. Without this, a model stuck in a
 * bad loop (e.g. repeatedly re-checking the same order) would run forever and
 * the job would never resolve.
 */
const MAX_ITERATIONS = 8;

/**
 * Free tier defaults to Flash: highest requests-per-day of the free models,
 * which matters when iterating on a demo. Overridable without touching code.
 */
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

const SYSTEM_PROMPT = `You are a support-ops agent for a D2C e-commerce company.
You investigate customer support tickets using the tools provided and decide what
action to take. You have exactly three tools: lookup_order, check_refund_policy,
and issue_refund.

Rules:
- Never assume order details from the customer's message alone — call lookup_order
  to confirm what actually happened.
- Always call check_refund_policy before issue_refund. Never judge eligibility
  yourself, and never call issue_refund for a policy-ineligible order.
- Never refund more than max_refundable_amount.
- Before each tool call, state in one short sentence why you're calling it — this
  becomes the audit trail a human reviews later.
- When you are done, reply with a brief final summary of what you found and what
  action (if any) you took. Do not call a tool in that final message.`;

interface TicketContext {
  message: string;
  customerId: number;
  orderId: number | null;
}

async function loadTicketContext(ticketId: number): Promise<TicketContext> {
  const { rows } = await pool.query<Ticket>('SELECT * FROM tickets WHERE id = $1', [ticketId]);
  const ticket = rows[0];
  if (!ticket) {
    throw new Error(`Ticket ${ticketId} not found`);
  }
  return { message: ticket.message, customerId: ticket.customer_id, orderId: ticket.order_id };
}

async function updateRunStatus(runId: number, status: RunStatus, terminal: boolean): Promise<void> {
  if (terminal) {
    await pool.query('UPDATE agent_runs SET status = $1, completed_at = NOW() WHERE id = $2', [status, runId]);
  } else {
    await pool.query('UPDATE agent_runs SET status = $1 WHERE id = $2', [status, runId]);
  }
}

async function writeAuditLog(runId: number, eventType: string, payload: unknown): Promise<void> {
  await pool.query('INSERT INTO audit_log (run_id, event_type, payload) VALUES ($1, $2, $3)', [
    runId,
    eventType,
    JSON.stringify(payload),
  ]);
}

async function writeStep(
  runId: number,
  stepOrder: number,
  toolCalled: string | null,
  input: unknown,
  output: unknown,
  reasoning: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO agent_steps (run_id, step_order, tool_called, input, output, reasoning)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      runId,
      stepOrder,
      toolCalled,
      input === undefined ? null : JSON.stringify(input),
      output === undefined ? null : JSON.stringify(output),
      reasoning,
    ],
  );
}

/**
 * Everything needed to pick a paused run back up in a different process.
 *
 * `pendingResponses` matters when the model emits several tool calls in one
 * turn and only a later one hits the gate: the earlier calls already executed
 * and their results must be replayed alongside the gated one, or the model
 * receives a turn whose tool responses do not match the calls it made.
 */
export interface ConversationState {
  contents: Content[];
  pendingResponses: Part[];
  stepOrder: number;
}

/**
 * Stop before a money-moving action and hand the decision to a human.
 *
 * Everything here is one transaction. A half-written pause -- an approval row
 * with no status change, or a status change with no approval row -- would
 * strand the run somewhere no code path can recover from.
 */
async function pauseForApproval(params: {
  runId: number;
  ticketId: number;
  action: ProposedAction;
  state: ConversationState;
  reasoning: string | null;
}): Promise<void> {
  const { runId, ticketId, action, state, reasoning } = params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO approvals (run_id, proposed_action, status)
       VALUES ($1, $2, 'pending')
       RETURNING id`,
      [runId, JSON.stringify(action)],
    );
    const approvalId = rows[0]!.id;

    // Not terminal: completed_at stays NULL. The run is suspended, not finished,
    // and a status of 'awaiting_approval' with an end time would be a lie.
    await client.query(
      `UPDATE agent_runs SET status = 'awaiting_approval', conversation_state = $1 WHERE id = $2`,
      [JSON.stringify(state), runId],
    );

    await client.query(`UPDATE tickets SET status = 'awaiting_approval' WHERE id = $1`, [ticketId]);

    // The interception is itself a step: the trace should show the agent
    // deciding to refund and being stopped, not a gap between two tool calls.
    await client.query(
      `INSERT INTO agent_steps (run_id, step_order, tool_called, input, output, reasoning)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        runId,
        state.stepOrder,
        action.tool,
        JSON.stringify(action.args),
        JSON.stringify({ intercepted: true, approval_id: approvalId, status: 'awaiting_approval' }),
        reasoning,
      ],
    );

    await client.query(
      `INSERT INTO audit_log (run_id, event_type, payload) VALUES ($1, 'approval_requested', $2)`,
      [runId, JSON.stringify({ approval_id: approvalId, ...action })],
    );

    await client.query('COMMIT');
    console.log(`[run ${runId}] paused for approval ${approvalId} (${action.tool})`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Constructed lazily: if GEMINI_API_KEY is missing, that failure belongs to the
// run (marked 'failed') rather than crashing the whole worker on import.
let genai: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!genai) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not set. Copy .env.example to .env and fill it in.');
    }
    genai = new GoogleGenAI({ apiKey });
  }
  return genai;
}

/**
 * The agent loop for one run: ask Gemini what to do, execute whatever tools it
 * calls, feed the results back, repeat until it stops calling tools or the
 * iteration cap is hit.
 *
 * Money-moving tool calls do not execute here. They suspend the run at the
 * approval gate; a human decides, and the run resumes from persisted
 * conversation state via resumeAgentLoop.
 */
export async function runAgentLoop(ticketId: number, runId: number): Promise<void> {
  const ctx = await loadTicketContext(ticketId);

  await updateRunStatus(runId, 'running', false);
  await writeAuditLog(runId, 'run_started', { ticket_id: ticketId, model: MODEL });

  // Gemini keeps conversation state in `contents`: each turn is appended, and
  // the whole array is resent every call. The model's own turns must be echoed
  // back verbatim or it loses track of which tool call a result belongs to.
  const contents: Content[] = [
    {
      role: 'user',
      parts: [
        {
          text:
            `Customer ticket (id ${ticketId}):\n"""\n${ctx.message}\n"""\n\n` +
            (ctx.orderId
              ? `Related order id: ${ctx.orderId}.`
              : 'No order was referenced in this ticket.'),
        },
      ],
    },
  ];

  let stepOrder = 0;

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const response = await getClient().models.generateContent({
        model: MODEL,
        contents,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        },
      });

      const candidateParts = response.candidates?.[0]?.content?.parts ?? [];
      const reasoning =
        candidateParts
          .map((p) => p.text ?? '')
          .join('\n')
          .trim() || null;

      const functionCalls = response.functionCalls ?? [];

      // Echo the model's turn back before appending results.
      contents.push({ role: 'model', parts: candidateParts });

      if (functionCalls.length === 0) {
        stepOrder += 1;
        await writeStep(runId, stepOrder, null, null, null, reasoning);
        await updateRunStatus(runId, 'completed', true);
        await writeAuditLog(runId, 'run_completed', { reasoning });
        return;
      }

      const responseParts: Part[] = [];
      for (const call of functionCalls) {
        const name = call.name ?? '';
        const args = call.args ?? {};

        // The approval gate. Money-moving tools stop here: the run is suspended
        // and a human decides. Note this is a check on the tool *name*, decided
        // in our code -- not something the model can talk its way past.
        if (MONEY_MOVING_TOOLS.has(name)) {
          stepOrder += 1;
          await pauseForApproval({
            runId,
            ticketId,
            action: { tool: name, args, ...(call.id ? { call_id: call.id } : {}) },
            state: { contents, pendingResponses: responseParts, stepOrder },
            reasoning,
          });
          return;
        }

        const result = await executeTool(name, args, { runId });

        stepOrder += 1;
        await writeStep(runId, stepOrder, name, args, result, reasoning);

        responseParts.push({
          functionResponse: {
            // `id` is only populated on some backends; echo it when present so
            // the model can match parallel calls to their results.
            ...(call.id ? { id: call.id } : {}),
            name,
            // The "output"/"error" keys are the documented convention for
            // telling the model whether the call succeeded.
            response: result.ok ? { output: result.data } : { error: result.error },
          },
        });
      }

      contents.push({ role: 'user', parts: responseParts });
    }

    await updateRunStatus(runId, 'failed', true);
    await writeAuditLog(runId, 'run_failed', {
      reason: `Exceeded ${MAX_ITERATIONS} tool-call iterations without reaching a conclusion`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateRunStatus(runId, 'failed', true);
    await writeAuditLog(runId, 'run_failed', { error: message });
    // Re-throw so BullMQ sees the job as failed and applies its retry/backoff policy.
    throw err;
  }
}
