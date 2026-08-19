# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AI Support-Ops Agent Platform — an agent that reads support tickets, calls tools to check
order/refund data, and decides an action, but pauses for human approval before executing
anything that moves money or when confidence is low. Every step is logged immutably;
retries can't double-refund. Currently **Week 1 — Foundation** (see README.md Status):
Postgres schema, seed data, and a bare ingestion/read API exist. The agent loop, BullMQ
worker, approval-gate logic, and frontend trace viewer are not yet built.

## Commands

```
docker-compose up -d      # start Postgres (5432) + Redis (6379)
npm install
npm run dev                # tsx watch src/index.ts — API with hot reload
npm run build               # tsc -> dist/
npm run start                # node dist/index.js
npm run typecheck            # tsc --noEmit
npm run db:migrate           # tsx src/db/migrate.ts — creates schema (idempotent, transactional)
npm run db:seed              # tsx src/db/seed.ts — wipes + reseeds demo data
```

No test runner or lint config exists yet. `.env` is required (copy `.env.example`); at minimum
Postgres either via `DATABASE_URL` or the discrete `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` vars.

## Architecture

Everything is ESM TypeScript (`"type": "module"`, `NodeNext` resolution) — relative imports
in `.ts` sources must use the `.js` extension (e.g. `import pool from './connection.js'`).

**Intended request flow** (from the design; only the first hop currently exists):
ticket arrives via `POST /tickets` → queued in BullMQ → orchestrator picks up the job → agent
calls tools (order lookup, refund policy check, issue refund) → if the action is money-moving
or confidence is low, it writes to `approvals` and pauses → a human approves/rejects → on
approve, a worker executes with an idempotency key → an `audit_log` row is written at every step.

**Data model** (`src/db/migrate.ts`, mirrored in `src/types.ts`):
- `customers`, `orders`, `tickets` — the domain data seed by `src/db/seed.ts`.
- `agent_runs` — one row per agent execution attempt on a ticket (`status`: pending → running →
  awaiting_approval → completed/failed).
- `agent_steps` — ordered log of what the agent did within a run (`tool_called`, `input`,
  `output`, `reasoning`), unique on `(run_id, step_order)`.
- `approvals` — the human-in-the-loop gate; `proposed_action` (JSONB) + status.
- `audit_log` — append-only. Postgres `RULE`s make `UPDATE`/`DELETE` silently no-op on this
  table, so immutability is enforced by the database, not application discipline.

Status enums (`OrderStatus`, `TicketStatus`, `RunStatus`, `ApprovalStatus` in `src/types.ts`)
are also enforced as `CHECK` constraints in the schema — keep both in sync when adding a status.

`orders.amount` (and any money value read from the DB) comes back from `pg` as a `string`, not
`number` — `DECIMAL` columns are typed that way deliberately to avoid float rounding on money.
Don't cast straight to `Number` for anything that flows into a refund calculation.

**DB connection** (`src/db/connection.ts`): a single exported `pool`. Branches on
`DATABASE_URL` — if set (hosted Postgres: Neon/Supabase), connects with
`ssl: { rejectUnauthorized: false }`; otherwise falls back to the discrete local/Docker vars
with no SSL. This is the only place that branch should live.

**API** (`src/index.ts`): `POST /tickets` creates the `ticket` + its `agent_runs` row (status
`pending`) + a `ticket_received` audit_log entry in one transaction — a ticket must never exist
without a run, and vice versa. `GET /tickets/:id/trace` is the read side the future frontend
trace viewer will consume: ticket + latest run + all steps + all approvals.

## Not yet built (don't assume these exist)

BullMQ queue/worker (dependency is installed, nothing enqueues or consumes jobs yet), the
Anthropic tool-calling agent loop, the three agent tools (order lookup, refund policy check,
issue refund), idempotency-key handling on the refund action, approval-gate write path, and the
frontend trace viewer.
