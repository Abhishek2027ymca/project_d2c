const pool = require('./connection');
require('dotenv').config();

const createTablesSQL = `
-- Customers table
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Orders table
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),
  status VARCHAR(50) DEFAULT 'active',
  amount DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tickets table (support requests)
CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),
  order_id INT REFERENCES orders(id),
  message TEXT NOT NULL,
  status VARCHAR(50) DEFAULT 'open',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Agent runs (one per ticket processed)
CREATE TABLE IF NOT EXISTS agent_runs (
  id SERIAL PRIMARY KEY,
  ticket_id INT NOT NULL REFERENCES tickets(id),
  status VARCHAR(50) DEFAULT 'pending',
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);

-- Agent steps (each tool call logged here)
CREATE TABLE IF NOT EXISTS agent_steps (
  id SERIAL PRIMARY KEY,
  run_id INT NOT NULL REFERENCES agent_runs(id),
  step_order INT NOT NULL,
  tool_called VARCHAR(100),
  input JSONB,
  output JSONB,
  reasoning TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Approvals (for money-moving or low-confidence actions)
CREATE TABLE IF NOT EXISTS approvals (
  id SERIAL PRIMARY KEY,
  run_id INT NOT NULL REFERENCES agent_runs(id),
  proposed_action VARCHAR(255) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  reviewed_by INT REFERENCES customers(id),
  reviewed_at TIMESTAMP
);

-- Audit log (append-only, never updated)
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  run_id INT NOT NULL REFERENCES agent_runs(id),
  event_type VARCHAR(100) NOT NULL,
  payload JSONB,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_tickets_customer ON tickets(customer_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_ticket ON agent_runs(ticket_id);
CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_steps(run_id);
CREATE INDEX IF NOT EXISTS idx_approvals_run ON approvals(run_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_log(run_id);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migrations...');
    await client.query(createTablesSQL);
    console.log('✓ Database schema created successfully');
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
