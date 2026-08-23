import express, { type Request, type Response } from 'express';
import 'dotenv/config';
import pool from './db/connection.js';
import { enqueueApprovalResume, enqueueTicket } from './queue/ticketQueue.js';
import { decideApproval } from './approvals/decide.js';
import type { AgentRun, AgentStep, Approval, Ticket } from './types.js';

const app = express();
const PORT = Number(process.env.API_PORT ?? 3000);

app.use(express.json());

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'up' });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'down' });
  }
});

/**
 * Ingest a ticket and open an agent run for it.
 *
 * Ticket + run are created in one transaction: a ticket with no run would sit
 * invisible to the worker forever, and a run pointing at no ticket is garbage.
 */
app.post('/tickets', async (req: Request, res: Response) => {
  const { customer_id, order_id, message } = req.body ?? {};

  if (typeof customer_id !== 'number' || typeof message !== 'string' || message.trim() === '') {
    res.status(400).json({ error: 'customer_id (number) and message (non-empty string) are required' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ticketResult = await client.query<Ticket>(
      `INSERT INTO tickets (customer_id, order_id, message)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [customer_id, order_id ?? null, message],
    );
    const ticket = ticketResult.rows[0]!;

    const runResult = await client.query<AgentRun>(
      `INSERT INTO agent_runs (ticket_id, status)
       VALUES ($1, 'pending')
       RETURNING *`,
      [ticket.id],
    );
    const run = runResult.rows[0]!;

    await client.query(
      `INSERT INTO audit_log (run_id, event_type, payload)
       VALUES ($1, 'ticket_received', $2)`,
      [run.id, JSON.stringify({ ticket_id: ticket.id, customer_id, order_id: order_id ?? null })],
    );

    await client.query('COMMIT');

    // Queued after commit, not inside the transaction: the ticket/run rows are
    // the source of truth. If the queue is unreachable the ticket still exists
    // and can be requeued later — it must not vanish because Redis was down.
    try {
      await enqueueTicket({ ticketId: ticket.id, runId: run.id });
    } catch (queueErr) {
      console.error(`Failed to enqueue run ${run.id}:`, queueErr);
      await pool.query('INSERT INTO audit_log (run_id, event_type, payload) VALUES ($1, $2, $3)', [
        run.id,
        'enqueue_failed',
        JSON.stringify({ error: queueErr instanceof Error ? queueErr.message : String(queueErr) }),
      ]);
    }

    res.status(201).json({ ticket_id: ticket.id, run_id: run.id, status: run.status });
  } catch (err) {
    await client.query('ROLLBACK');
    // A bad customer_id / order_id trips a foreign-key violation, which is a
    // client error, not a server fault.
    if (err instanceof Error && 'code' in err && err.code === '23503') {
      res.status(400).json({ error: 'customer_id or order_id does not exist' });
      return;
    }
    console.error('POST /tickets failed:', err);
    res.status(500).json({ error: 'Failed to create ticket' });
  } finally {
    client.release();
  }
});

/** Full trace for one ticket: the run, every step it took, and any approvals. */
app.get('/tickets/:id/trace', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'ticket id must be a positive integer' });
    return;
  }

  try {
    const ticketResult = await pool.query<Ticket>('SELECT * FROM tickets WHERE id = $1', [id]);
    const ticket = ticketResult.rows[0];
    if (!ticket) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }

    const runResult = await pool.query<AgentRun>(
      'SELECT * FROM agent_runs WHERE ticket_id = $1 ORDER BY started_at DESC LIMIT 1',
      [id],
    );
    const run = runResult.rows[0] ?? null;

    if (!run) {
      res.json({ ticket, run: null, steps: [], approvals: [] });
      return;
    }

    const [steps, approvals] = await Promise.all([
      pool.query<AgentStep>('SELECT * FROM agent_steps WHERE run_id = $1 ORDER BY step_order', [run.id]),
      pool.query<Approval>('SELECT * FROM approvals WHERE run_id = $1 ORDER BY id', [run.id]),
    ]);

    res.json({ ticket, run, steps: steps.rows, approvals: approvals.rows });
  } catch (err) {
    console.error('GET /tickets/:id/trace failed:', err);
    res.status(500).json({ error: 'Failed to fetch trace' });
  }
});

/** The review queue: every action waiting on a human, oldest first. */
app.get('/approvals', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.run_id, a.proposed_action, a.status, a.created_at,
              r.ticket_id, t.message AS ticket_message, t.customer_id
         FROM approvals a
         JOIN agent_runs r ON r.id = a.run_id
         JOIN tickets t    ON t.id = r.ticket_id
        WHERE a.status = 'pending'
        ORDER BY a.created_at`,
    );
    res.json({ pending: rows });
  } catch (err) {
    console.error('GET /approvals failed:', err);
    res.status(500).json({ error: 'Failed to list approvals' });
  }
});

/**
 * Record a human verdict and let the run continue.
 *
 * The state machine lives in src/approvals/decide.ts; this maps its outcome
 * onto status codes. 404 and 409 stay distinct — "no such approval" and
 * "already decided" are different problems for whoever is looking at the
 * dashboard.
 */
async function handleDecision(
  req: Request,
  res: Response,
  decision: 'approved' | 'rejected',
): Promise<void> {
  const { reviewed_by, reason } = req.body ?? {};

  try {
    const outcome = await decideApproval({
      approvalId: Number(req.params.id),
      decision,
      reviewedBy: reviewed_by,
      reason,
    });

    if (!outcome.ok) {
      if (outcome.code === 'invalid') {
        res.status(400).json({ error: outcome.message });
      } else if (outcome.code === 'not_found') {
        res.status(404).json({ error: 'Approval not found' });
      } else {
        res.status(409).json({
          error: `Approval ${req.params.id} was already ${outcome.status}`,
          status: outcome.status,
        });
      }
      return;
    }

    // Queued after the verdict is committed, for the same reason ticket
    // ingestion is: the decision is the source of truth. If Redis is
    // unreachable the decision still stands and can be requeued, rather than
    // being lost because a queue write failed.
    try {
      await enqueueApprovalResume({
        ticketId: outcome.ticketId,
        runId: outcome.runId,
        approvalId: outcome.approvalId,
      });
    } catch (queueErr) {
      console.error(`Failed to enqueue resume for approval ${outcome.approvalId}:`, queueErr);
      await pool.query('INSERT INTO audit_log (run_id, event_type, payload) VALUES ($1, $2, $3)', [
        outcome.runId,
        'enqueue_failed',
        JSON.stringify({
          approval_id: outcome.approvalId,
          error: queueErr instanceof Error ? queueErr.message : String(queueErr),
        }),
      ]);
    }

    res.json({
      approval_id: outcome.approvalId,
      status: outcome.decision,
      run_id: outcome.runId,
      resumed: true,
    });
  } catch (err) {
    console.error(`POST /approvals/${req.params.id}/${decision} failed:`, err);
    res.status(500).json({ error: 'Failed to record decision' });
  }
}

app.post('/approvals/:id/approve', (req, res) => handleDecision(req, res, 'approved'));
app.post('/approvals/:id/reject', (req, res) => handleDecision(req, res, 'rejected'));

app.listen(PORT, () => {
  console.log(`✓ API listening on http://localhost:${PORT}`);
});
