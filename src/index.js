const express = require('express');
const pool = require('./db/connection');
require('dotenv').config();

const app = express();
const PORT = process.env.API_PORT || 3000;

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// POST /tickets - Ingest a new ticket
app.post('/tickets', async (req, res) => {
  const { customer_id, order_id, message } = req.body;

  if (!customer_id || !message) {
    return res.status(400).json({ error: 'customer_id and message required' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO tickets (customer_id, order_id, message, status) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
      [customer_id, order_id || null, message, 'open']
    );

    const ticketId = result.rows[0].id;

    // Create agent run for this ticket
    const runResult = await pool.query(
      'INSERT INTO agent_runs (ticket_id, status) VALUES ($1, $2) RETURNING id',
      [ticketId, 'pending']
    );

    res.status(201).json({
      ticket_id: ticketId,
      run_id: runResult.rows[0].id,
      message: 'Ticket created successfully',
    });
  } catch (err) {
    console.error('Error creating ticket:', err);
    res.status(500).json({ error: 'Failed to create ticket' });
  }
});

// GET /tickets/:id/trace - Get ticket details and agent steps
app.get('/tickets/:id/trace', async (req, res) => {
  const { id } = req.params;

  try {
    // Get ticket
    const ticketResult = await pool.query(
      'SELECT * FROM tickets WHERE id = $1',
      [id]
    );

    if (ticketResult.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const ticket = ticketResult.rows[0];

    // Get agent run
    const runResult = await pool.query(
      'SELECT * FROM agent_runs WHERE ticket_id = $1',
      [id]
    );

    const run = runResult.rows[0] || null;

    // Get agent steps (if run exists)
    let steps = [];
    if (run) {
      const stepsResult = await pool.query(
        'SELECT * FROM agent_steps WHERE run_id = $1 ORDER BY step_order',
        [run.id]
      );
      steps = stepsResult.rows;
    }

    // Get approvals (if run exists)
    let approvals = [];
    if (run) {
      const approvalsResult = await pool.query(
        'SELECT * FROM approvals WHERE run_id = $1',
        [run.id]
      );
      approvals = approvalsResult.rows;
    }

    res.json({
      ticket,
      run,
      steps,
      approvals,
    });
  } catch (err) {
    console.error('Error fetching ticket trace:', err);
    res.status(500).json({ error: 'Failed to fetch ticket trace' });
  }
});

app.listen(PORT, () => {
  console.log(`✓ Server running on port ${PORT}`);
});
