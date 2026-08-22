# AI Support-Ops Agent Platform

An AI agent that reads support tickets, checks order/refund data, and decides actions —
but pauses for human approval before executing money-moving actions. Every step is
logged immutably. Retries can't double-refund.

## Status: Week 2 — Agent Loop + Tool Execution (complete)

See [PROGRESS.md](PROGRESS.md) for the full week-by-week log: what was
built, key decisions, and bugs hit along the way.

## Setup

1. Provision Postgres and Redis (hosted, not Docker — see note below):
   - [Neon](https://neon.tech) → new project → copy the connection string
   - [Upstash](https://upstash.com) → new Redis database → copy the
     `rediss://` connection string (not the REST API URL)

2. Install dependencies:
   ```
   npm install
   ```

3. Get a Gemini API key (free tier, no credit card) from
   [Google AI Studio](https://aistudio.google.com/apikey).

4. Copy `.env.example` to `.env` and fill in `DATABASE_URL`, `REDIS_URL`,
   and `GEMINI_API_KEY`.

5. Run migrations:
   ```
   npm run db:migrate
   ```

6. Seed demo data:
   ```
   npm run db:seed
   ```

7. Start the API and the worker (two separate processes):
   ```
   npm run dev      # API
   npm run worker   # agent loop consumer
   ```

> `docker-compose.yml` is kept in the repo as a local-dev fallback but isn't
> the primary path right now — Docker Desktop wasn't working reliably on the
> dev machine, so hosted Postgres/Redis took over. Same connection-string
> shape either way (`src/db/connection.ts`, `src/queue/connection.ts`), so
> switching back later is a config change, not a code change.

## Verification

Two smoke tests, both runnable without an LLM API key:

```
npm run verify:tools   # the three agent tools, straight against Postgres
npm run verify:queue   # queue producer: dedup, job shape, retry config
```

`verify:tools` is destructive — it issues real refunds against seeded orders.
Restore with `npm run db:seed` afterwards (it reminds you on exit).

## API Endpoints

- `GET /health` — health check
- `POST /tickets` — create a ticket, open an agent run, enqueue it for
  processing
- `GET /tickets/:id/trace` — ticket + latest run + every step + any approvals

## Architecture

```
POST /tickets ──▶ tickets + agent_runs (Postgres) ──▶ BullMQ queue (Redis)
                                                              │
                                                              ▼
                                                     worker.ts picks up job
                                                              │
                                                              ▼
                                          orchestrator.ts: Gemini tool loop
                                          (lookup_order, check_refund_policy,
                                           issue_refund) — one agent_steps
                                          row per tool call, audit_log entry
                                          at start/end of the run
```
