import pool from './connection.js';

const schema = `
CREATE TABLE IF NOT EXISTS customers (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  email      VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id          SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status      VARCHAR(50) NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','shipped','delivered','refunded','cancelled')),
  amount      DECIMAL(10,2) NOT NULL CHECK (amount >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tickets (
  id          SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  order_id    INT REFERENCES orders(id) ON DELETE SET NULL,
  message     TEXT NOT NULL,
  status      VARCHAR(50) NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','processing','awaiting_approval','resolved','rejected')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id           SERIAL PRIMARY KEY,
  ticket_id    INT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  status       VARCHAR(50) NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','running','awaiting_approval','completed','failed')),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS agent_steps (
  id          SERIAL PRIMARY KEY,
  run_id      INT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step_order  INT NOT NULL,
  tool_called VARCHAR(100),
  input       JSONB,
  output      JSONB,
  reasoning   TEXT,
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, step_order)
);

CREATE TABLE IF NOT EXISTS approvals (
  id              SERIAL PRIMARY KEY,
  run_id          INT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  proposed_action JSONB NOT NULL,
  status          VARCHAR(50) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected')),
  reviewed_by     VARCHAR(255),
  reviewed_at     TIMESTAMPTZ
);

-- Every refund that actually executed, keyed by an idempotency key supplied by
-- the caller. The UNIQUE constraint is what makes a retry safe: the second
-- attempt collides instead of paying out again, and returns the stored result
-- of the first -- a retry of a succeeded operation is a success, not an error.
-- The result column stays NULL until the money actually moves, so a row that
-- exists with no result is a crashed attempt rather than a completed one.
CREATE TABLE IF NOT EXISTS refunds (
  id              SERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  run_id          INT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  order_id        INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount          DECIMAL(10,2) NOT NULL CHECK (amount > 0),
  reason          TEXT NOT NULL,
  result          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Added after the initial schema shipped, so these run as ALTERs rather than
-- being folded into CREATE TABLE above -- CREATE TABLE IF NOT EXISTS is a no-op
-- on an existing table and would silently skip new columns.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS conversation_state JSONB;
ALTER TABLE approvals  ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE approvals  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Append-only. Nothing in the app may ever UPDATE or DELETE a row here;
-- the rules below make the database enforce that, not just convention.
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  run_id     INT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  event_type VARCHAR(100) NOT NULL,
  payload    JSONB,
  timestamp  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE RULE audit_log_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
CREATE OR REPLACE RULE audit_log_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING;

CREATE INDEX IF NOT EXISTS idx_orders_customer     ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_tickets_customer    ON tickets(customer_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status      ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_ticket   ON agent_runs(ticket_id);
CREATE INDEX IF NOT EXISTS idx_agent_steps_run     ON agent_steps(run_id, step_order);
CREATE INDEX IF NOT EXISTS idx_approvals_run       ON approvals(run_id);
CREATE INDEX IF NOT EXISTS idx_approvals_pending   ON approvals(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_audit_run           ON audit_log(run_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_refunds_run         ON refunds(run_id);
CREATE INDEX IF NOT EXISTS idx_refunds_order       ON refunds(order_id);
`;

async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    console.log('Running migrations...');
    // One transaction: either the whole schema lands or none of it does.
    await client.query('BEGIN');
    await client.query(schema);
    await client.query('COMMIT');
    console.log('✓ Schema created');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

await migrate();
