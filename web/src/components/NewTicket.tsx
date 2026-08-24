import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Customer, Order } from '../types';

export function NewTicket({ onCreated }: { onCreated: (ticketId: number) => void }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [customerId, setCustomerId] = useState<number | ''>('');
  const [orderId, setOrderId] = useState<number | ''>('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.demoData()
      .then((d) => { setCustomers(d.customers); setOrders(d.orders); })
      .catch((e: Error) => setError(e.message));
  }, []);

  // Only the selected customer's orders: a ticket about someone else's order is
  // nonsense the agent would have to reason its way out of for no reason.
  const visibleOrders = customerId === '' ? [] : orders.filter((o) => o.customer_id === customerId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (customerId === '' || message.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.createTicket({
        customer_id: customerId,
        order_id: orderId === '' ? null : orderId,
        message: message.trim(),
      });
      setMessage('');
      onCreated(r.ticket_id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="section" onSubmit={submit}>
      <h2>New ticket</h2>

      <div className="field">
        <label htmlFor="cust">Customer</label>
        <select
          id="cust"
          value={customerId}
          onChange={(e) => {
            setCustomerId(e.target.value === '' ? '' : Number(e.target.value));
            setOrderId('');
          }}
        >
          <option value="">Select…</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="order">Order</label>
        <select
          id="order"
          value={orderId}
          disabled={customerId === ''}
          onChange={(e) => setOrderId(e.target.value === '' ? '' : Number(e.target.value))}
        >
          <option value="">None</option>
          {visibleOrders.map((o) => (
            <option key={o.id} value={o.id}>
              #{o.id} · ${o.amount} · {o.status}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="msg">Message</label>
        <textarea
          id="msg"
          value={message}
          placeholder="The laptop arrived damaged and I want a refund."
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>

      {error && <div className="error">{error}</div>}

      <button className="primary" disabled={busy || customerId === '' || message.trim() === ''}>
        {busy ? 'Submitting…' : 'Submit ticket'}
      </button>
    </form>
  );
}
