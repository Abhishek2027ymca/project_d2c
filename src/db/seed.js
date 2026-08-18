const pool = require('./connection');
require('dotenv').config();

const seedData = async () => {
  const client = await pool.connect();
  try {
    console.log('Seeding database...');

    // Insert customers
    const customers = [
      { name: 'Alice Johnson', email: 'alice@example.com' },
      { name: 'Bob Smith', email: 'bob@example.com' },
      { name: 'Charlie Brown', email: 'charlie@example.com' },
      { name: 'Diana Prince', email: 'diana@example.com' },
      { name: 'Eve Wilson', email: 'eve@example.com' },
    ];

    const customerIds = [];
    for (const customer of customers) {
      const result = await client.query(
        'INSERT INTO customers (name, email) VALUES ($1, $2) RETURNING id',
        [customer.name, customer.email]
      );
      customerIds.push(result.rows[0].id);
    }

    // Insert orders
    const orders = [
      { customer_id: customerIds[0], amount: 99.99, status: 'active' },
      { customer_id: customerIds[0], amount: 150.00, status: 'active' },
      { customer_id: customerIds[1], amount: 45.50, status: 'active' },
      { customer_id: customerIds[1], amount: 200.00, status: 'active' },
      { customer_id: customerIds[2], amount: 75.25, status: 'active' },
      { customer_id: customerIds[2], amount: 120.00, status: 'active' },
      { customer_id: customerIds[3], amount: 180.75, status: 'active' },
      { customer_id: customerIds[3], amount: 95.00, status: 'active' },
      { customer_id: customerIds[4], amount: 250.00, status: 'active' },
      { customer_id: customerIds[4], amount: 80.50, status: 'active' },
    ];

    const orderIds = [];
    for (const order of orders) {
      const result = await client.query(
        'INSERT INTO orders (customer_id, amount, status) VALUES ($1, $2, $3) RETURNING id',
        [order.customer_id, order.amount, order.status]
      );
      orderIds.push(result.rows[0].id);
    }

    // Insert sample tickets
    const tickets = [
      {
        customer_id: customerIds[0],
        order_id: orderIds[0],
        message: 'I never received my order #' + orderIds[0],
      },
      {
        customer_id: customerIds[1],
        order_id: orderIds[2],
        message: 'The product arrived damaged, I need a refund',
      },
      {
        customer_id: customerIds[2],
        order_id: orderIds[4],
        message: 'Charged twice for the same order',
      },
    ];

    for (const ticket of tickets) {
      await client.query(
        'INSERT INTO tickets (customer_id, order_id, message, status) VALUES ($1, $2, $3, $4)',
        [ticket.customer_id, ticket.order_id, ticket.message, 'open']
      );
    }

    console.log('✓ Database seeded successfully');
    console.log(`  - ${customerIds.length} customers created`);
    console.log(`  - ${orderIds.length} orders created`);
    console.log(`  - ${tickets.length} tickets created`);
  } catch (err) {
    console.error('Seed error:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

seedData();
