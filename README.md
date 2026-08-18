# AI Support-Ops Agent Platform

An AI agent that reads support tickets, checks order/refund data, and decides actions —
but pauses for human approval before executing money-moving actions. Every step is
logged immutably. Retries can't double-refund.

## Status: Week 1 — Foundation (in progress)

## Setup

1. Start Postgres + Redis:
   ```
   docker-compose up -d
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Copy `.env.example` to `.env` and fill in values.

4. Run migrations:
   ```
   npm run db:migrate
   ```

5. Seed demo data:
   ```
   npm run db:seed
   ```

6. Start the API:
   ```
   npm run dev
   ```

## API Endpoints (Week 1)

- `GET /health` — health check
- `POST /tickets` — create a new ticket
- `GET /tickets/:id/trace` — get ticket + agent run + steps + approvals
