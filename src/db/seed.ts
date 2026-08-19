import pool from './connection.js';
import type { OrderStatus } from '../types.js';

interface SeedOrder {
  customerIdx: number;
  amount: number;
  status: OrderStatus;
}

interface SeedTicket {
  customerIdx: number;
  orderIdx: number;
  message: string;
}

const CUSTOMERS = [
  { name: 'Alice Johnson', email: 'alice@example.com' },
  { name: 'Bob Smith', email: 'bob@example.com' },
  { name: 'Charlie Brown', email: 'charlie@example.com' },
  { name: 'Diana Prince', email: 'diana@example.com' },
  { name: 'Eve Wilson', email: 'eve@example.com' },
];

// Deliberately spans the interesting cases: cheap vs. expensive (approval
// threshold), already-refunded (idempotency), cancelled (invalid refund target).
const ORDERS: SeedOrder[] = [
  { customerIdx: 0, amount: 49.99, status: 'delivered' },
  { customerIdx: 0, amount: 1250.0, status: 'delivered' },
  { customerIdx: 1, amount: 89.5, status: 'shipped' },
  { customerIdx: 1, amount: 210.0, status: 'refunded' },
  { customerIdx: 2, amount: 34.25, status: 'delivered' },
  { customerIdx: 2, amount: 675.0, status: 'delivered' },
  { customerIdx: 3, amount: 120.75, status: 'cancelled' },
  { customerIdx: 3, amount: 95.0, status: 'active' },
  { customerIdx: 4, amount: 2400.0, status: 'delivered' },
  { customerIdx: 4, amount: 15.5, status: 'delivered' },
];

const TICKETS: SeedTicket[] = [
  { customerIdx: 0, orderIdx: 0, message: 'My order never arrived. Can I get a refund?' },
  { customerIdx: 0, orderIdx: 1, message: 'This laptop arrived with a cracked screen. I want my money back.' },
  { customerIdx: 1, orderIdx: 3, message: 'Please refund this order — I am not sure it went through last time.' },
  { customerIdx: 2, orderIdx: 5, message: 'Wrong item shipped. Requesting full refund.' },
  { customerIdx: 3, orderIdx: 6, message: 'I cancelled this order but was still charged.' },
  { customerIdx: 4, orderIdx: 8, message: 'Product stopped working after two days. Refund please.' },
  { customerIdx: 4, orderIdx: 9, message: 'What is your return window? Just asking, no action needed.' },
];

async function seed(): Promise<void> {
  const client = await pool.connect();
  try {
    console.log('Seeding database...');
    await client.query('BEGIN');

    // Idempotent seed: wipe first so re-running does not stack duplicates.
    // RESTART IDENTITY keeps IDs predictable between runs, which matters when
    // hand-testing endpoints against known ticket IDs.
    await client.query(
      'TRUNCATE audit_log, approvals, agent_steps, agent_runs, tickets, orders, customers RESTART IDENTITY CASCADE',
    );

    const customerIds: number[] = [];
    for (const c of CUSTOMERS) {
      const { rows } = await client.query<{ id: number }>(
        'INSERT INTO customers (name, email) VALUES ($1, $2) RETURNING id',
        [c.name, c.email],
      );
      customerIds.push(rows[0]!.id);
    }

    const orderIds: number[] = [];
    for (const o of ORDERS) {
      const { rows } = await client.query<{ id: number }>(
        'INSERT INTO orders (customer_id, amount, status) VALUES ($1, $2, $3) RETURNING id',
        [customerIds[o.customerIdx], o.amount, o.status],
      );
      orderIds.push(rows[0]!.id);
    }

    for (const t of TICKETS) {
      await client.query(
        'INSERT INTO tickets (customer_id, order_id, message) VALUES ($1, $2, $3)',
        [customerIds[t.customerIdx], orderIds[t.orderIdx], t.message],
      );
    }

    await client.query('COMMIT');
    console.log('✓ Seeded');
    console.log(`  ${customerIds.length} customers`);
    console.log(`  ${orderIds.length} orders`);
    console.log(`  ${TICKETS.length} tickets`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

await seed();
