# AI Support-Ops Agent Platform

An AI agent that reads support tickets, checks order/refund data, and decides actions —
but pauses for human approval before executing money-moving actions. Every step is
logged immutably. Retries can't double-refund.

## Status: Week 3 — Approval Gate + Idempotent Execution (complete)

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

Three smoke tests, all runnable without an LLM API key:

```
npm run verify:tools       # the three agent tools + idempotency (19 checks)
npm run verify:queue       # queue producer: dedup, job shape, retry config
npm run verify:approvals   # the approval state machine, incl. a real race (12 checks)
```

`verify:tools` and `verify:approvals` are destructive — they issue real refunds
and write scratch rows against seeded data. Restore with `npm run db:seed`.

`npm run queue:clear` drains the queue. Reseeding the database restarts run ids,
so a queue still holding finished jobs under those ids will silently reject the
new work — reset both together.

## API Endpoints

- `GET /health` — health check
- `POST /tickets` — create a ticket, open an agent run, enqueue it for
  processing
- `GET /tickets/:id/trace` — ticket + latest run + every step + any approvals
- `GET /approvals` — the review queue: actions waiting on a human
- `POST /approvals/:id/approve` — `{ reviewed_by, reason? }`
- `POST /approvals/:id/reject` — `{ reviewed_by, reason }` (reason required)

## Architecture

```
POST /tickets ──▶ tickets + agent_runs (Postgres) ──▶ BullMQ queue (Redis)
                                                              │
                                                              ▼
                                                     worker.ts picks up job
                                                              │
                                                              ▼
                                          orchestrator.ts: Gemini tool loop
                                          (lookup_order, check_refund_policy)
                                                              │
                                        model wants to issue_refund (money)
                                                              │
                                                              ▼
                                    ┌─────────────────────────────────────┐
                                    │  GATE: run suspends.                │
                                    │  approvals row + conversation saved │
                                    │  status = awaiting_approval         │
                                    └─────────────────────────────────────┘
                                                              │
                                     POST /approvals/:id/approve|reject
                                                              │
                                                              ▼
                                    worker resumes from saved conversation,
                                    executes the *approved* action with
                                    idempotency key `approval-<id>`
                                                              │
                                                              ▼
                                    model writes its closing summary; run
                                    completes. audit_log entry at every step.
```

The refund never executes inside the agent loop. The model can only ever
*propose* it — the gate keys off the tool name in our code, so a model that has
been talked into refunding still cannot pay anyone.
