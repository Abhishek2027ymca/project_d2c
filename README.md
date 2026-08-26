# AI Support-Ops Agent Platform

An AI agent that reads e-commerce support tickets, checks real order and refund
data, and decides what to do — but it cannot move money on its own. When it
wants to issue a refund, it stops and waits for a human. Every step it takes is
logged immutably, and a retried action can never pay out twice.

**Status:** dashboard built, deploy pending. See [PROGRESS.md](PROGRESS.md) for
the full week-by-week engineering log — what was built, the reasoning behind
each decision, and the bugs hit along the way.

## The problem

Most "AI agent" demos call an LLM and print an answer. That's fine for a
chatbot. It's not fine for something that touches money: an agent that can
hallucinate a refund, retry the same action twice on a network hiccup, or take
an action with no record of why, is not something you'd let near production
data.

This project is scoped around that gap specifically, for one domain — D2C
support tickets — rather than trying to be a general agent framework. Three
properties do the actual work:

- **A human approves anything that moves money.** The agent can *propose* a
  refund; it cannot *execute* one. That decision is enforced in code, not by
  asking the model to behave.
- **Retries can't double-refund.** Every money-moving action carries an
  idempotency key. Replaying it — a network retry, a queue redelivery, a
  reviewer double-clicking Approve — returns the original result instead of
  paying out again.
- **Every step is logged, and the log can't be edited after the fact.**
  Postgres rules make `UPDATE`/`DELETE` on the audit table silent no-ops. If
  something did happen, there's a row that says so and nothing can quietly
  erase it.

## What it does

Submit a ticket → the agent looks up the real order, checks it against refund
policy, and decides whether a refund is warranted. If it decides yes, the run
**pauses** — nothing has moved yet — and shows up in a review queue. A human
approves or rejects with a reason. Only then does the refund execute, and only
once, however many times the approval gets retried underneath it.

The dashboard (`web/`) is the actual demo: submit a ticket, watch the agent's
steps appear in real time, act on what it's waiting for, see the outcome.

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

**Stack:** Node.js + TypeScript (strict, ESM), Postgres (Neon), Redis + BullMQ
(Upstash), Gemini 2.5 Flash for tool-calling, Vite + React for the dashboard —
all one deployable service, no CORS, no second host to keep awake.

## Design decisions worth defending

**The gate keys off the tool name, decided in server code — not off anything
the model reports about itself.** A model that's been talked into refunding
(bad prompt, confused reasoning, an injected instruction in a ticket) still
cannot execute the tool; it can only ever request it. Any design where the
model self-reports its own confidence or risk is one prompt injection away
from being no gate at all.

**A retry of a *succeeded* action returns success, not an error.** The
first version of this only had a conditional `UPDATE … WHERE status <>
'refunded'` — enough to stop a double-payout, but it could only ever say "no
rows matched." A caller retrying after a timeout was told its refund was
*denied*, when in fact it had already gone through. `refunds.idempotency_key`
is `UNIQUE`; replaying it now returns the stored result of the original
attempt. Two layers stayed in place on purpose: the idempotency key catches a
replay of the *same* logical refund, the conditional `UPDATE` catches a
*different* refund racing for the same order.

**What was approved is what runs.** On resume, the action executed is the one
stored on the approval row at interception time — never a fresh one re-asked
of the model. A human approved a specific order and a specific amount;
re-prompting could return something else, and the approval would then be
authorizing an action nobody actually reviewed.

**The verdict is a conditional `UPDATE … WHERE status = 'pending'`**, so the
database — not application logic — decides who wins when two reviewers click
Approve at the same moment. Tested directly: `npm run verify:approvals` fires
three simultaneous approvals on separate connections and asserts exactly one
wins, the other two get a clean `409 already_decided`, and the audit log ends
with exactly one entry.

**The paused run survives the process dying.** The full model conversation
is persisted to `agent_runs.conversation_state` at the moment of interception,
so the worker that resumes a run after approval doesn't have to be the same
process — or even the same machine — that started it.

## What was cut, and why

Scoped deliberately for a one-month build, not because these don't matter:

- **Confidence-based gating.** The gate currently triggers on money-moving
  tools only, not on "the model seems unsure." A confidence signal that isn't
  the model marking its own homework is a design problem, not a coding one —
  building it without a real signal would just be theater.
- **Auth on the approval endpoints.** `reviewed_by` is whatever the caller
  claims. Fine for a single-tenant demo where the "team" is one person
  reviewing their own agent; not fine for anything with more than one
  reviewer.
- **Multi-tenancy, semantic caching, an eval suite scoring agent decisions
  against a labelled set, load testing, and an observability stack
  (Prometheus/Grafana).** All real, all deliberately out of scope for an MVP
  meant to prove one thing well: that an agent can be made safe enough to
  move money, on a machine with 12GB of RAM and a one-month clock.
- **Kafka.** BullMQ + Redis is the defensible choice at this scale — heavier
  infrastructure here would be resume-padding, not an improvement.

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

7. Build the dashboard:
   ```
   npm run build:web
   ```

8. Start the API and the worker (two separate processes):
   ```
   npm run dev      # API + dashboard on http://localhost:3000
   npm run worker   # agent loop consumer
   ```

   Then open **http://localhost:3000**.

   While working on the frontend, run `npm run dev:web` as a third process
   instead — Vite serves it on :5173 with hot reload and proxies API calls
   to :3000.

> `docker-compose.yml` is kept in the repo as a local-dev fallback but isn't
> the primary path right now — Docker Desktop wasn't working reliably on the
> dev machine, so hosted Postgres/Redis took over. Same connection-string
> shape either way (`src/db/connection.ts`, `src/queue/connection.ts`), so
> switching back later is a config change, not a code change.

**Production build**, the shape a host like Render or Railway will run:

```
npm run build     # tsc -> dist/, then builds the dashboard into public/
npm start         # node dist/index.js — API + dashboard
node dist/worker.js  # the queue consumer, as a second process
```

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
- `GET /tickets` — every ticket with the state of its latest run
- `GET /demo-data` — customers and orders, for the submission form
- `GET /approvals` — the review queue: actions waiting on a human
- `POST /approvals/:id/approve` — `{ reviewed_by, reason? }`
- `POST /approvals/:id/reject` — `{ reviewed_by, reason }` (reason required)

## Dashboard

`web/` is a Vite + React app built into `public/`, which the API serves — one
deployable service, no CORS. Submit a ticket, watch the agent's steps appear,
approve or reject what it's waiting on, see the outcome.

The gate step is styled distinctly from the rest of the timeline: a reviewer
should see at a glance that the agent *stopped* rather than proceeded, since
that's the difference the whole project is about.

Refresh is a 2s poll, not SSE — a run finishes in ~20s, and polling stops on
its own once nothing is in flight.

## Next steps

- Deploy: Render/Railway for the API + worker (needs a persistent process —
  not serverless, since BullMQ workers block waiting on the queue), pointing
  at the existing Neon and Upstash instances.
- A short demo video, as a fallback for when a free-tier host is asleep.
- The gaps above, roughly in the order a real support-ops team would ask for
  them: auth first, confidence-based gating second, everything else after.
