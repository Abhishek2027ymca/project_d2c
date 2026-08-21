# Progress Log

Running engineering log, week by week: what was built, why, what broke, and
how it got fixed. Kept separate from README.md — this is the working log,
README is the pitch. Dates are IST.

---

## Week 1 — Foundation (2026-08-18 → 2026-08-19)

### Built
- Postgres schema (`src/db/migrate.ts`): 7 tables — `customers`, `orders`,
  `tickets`, `agent_runs`, `agent_steps`, `approvals`, `audit_log`. Status
  columns are `CHECK`-constrained against the enums in `src/types.ts`, and
  `audit_log` has Postgres `RULE`s that make `UPDATE`/`DELETE` on it silent
  no-ops — append-only enforced by the database, not application discipline.
- Express API (`src/index.ts`): `GET /health`, `POST /tickets`,
  `GET /tickets/:id/trace`.
- Seed script (`src/db/seed.ts`) — 5 customers, 10 orders, 7 tickets,
  deliberately spanning edge cases: already-refunded, cancelled, high-value.
- Converted the initial JS scaffold to TypeScript (strict mode) before
  writing real logic, to match the stated stack and avoid a much more
  expensive conversion later.

### Key decisions
- `orders.amount` is read back from Postgres as a **string**, typed that way
  on purpose (`src/types.ts`) — `pg` returns `DECIMAL` columns as strings to
  avoid float rounding on money. Casting straight to `Number` anywhere in the
  refund path is how a ₹0.01 discrepancy gets in.
- Ticket + `agent_runs` row + `ticket_received` audit log entry are written
  in one transaction (`POST /tickets`). A ticket with no run would sit
  invisible to the worker forever.
- Docker Desktop wasn't working on this machine, so local Postgres moved to
  **Neon** (hosted, free tier) instead of `docker-compose up`. Same
  `DATABASE_URL` pattern this project would use in production anyway, so
  nothing about the code changed — `src/db/connection.ts` already branched on
  `DATABASE_URL` vs. discrete `DB_*` vars for exactly this reason.

### Bugs hit
- Initial `package.json` listed `anthropic` and `bull` as dependencies —
  wrong package names. Correct ones: `@anthropic-ai/sdk` and `bullmq`.
- `docker-compose.yml` still references `postgres:15-alpine` (no pgvector)
  and the obsolete `version: '3.8'` key. Left as-is since Neon is the primary
  path now — noted here so it doesn't quietly rot as "the real setup."

### Verified
Migration + seed ran clean against Neon. All three endpoints tested,
including error paths: 400 on missing fields, 400 on a bad `customer_id`
(FK violation caught and reported, not a 500), 404 on an unknown ticket id.
Confirmed `audit_log` actually receives rows, not just that the request
returns 201.

---

## Week 2 — Agent Loop + Tool Execution (started 2026-08-19)

### Built
- Three tools (`src/tools/`): `lookupOrder`, `checkRefundPolicy`,
  `issueRefund`.
- Tool schemas for Claude (`src/agent/toolSchemas.ts`) — `strict: true` +
  `additionalProperties: false` so tool-call arguments validate exactly.
- Tool dispatcher (`src/agent/executeTool.ts`) — re-validates input even
  though the schemas are strict, because the schema is a contract with the
  model, not a security boundary; this is where untrusted input actually
  enters real code.
- BullMQ ticket queue + Redis connection (`src/queue/`) — `jobId` is keyed on
  the run id (`run-${runId}`), so a duplicate `POST /tickets` can't spawn two
  runs for the same run record.
- **Agent orchestrator** (`src/agent/orchestrator.ts`) — the actual Claude
  tool-calling loop: load the ticket, call Claude with the 3 tool schemas,
  execute whatever it calls via the dispatcher, write one `agent_steps` row
  per tool call, repeat until the model stops calling tools or an 8-iteration
  cap is hit. Marks the run `completed` or `failed` with a matching
  `audit_log` entry either way.
- Worker entrypoint (`src/worker.ts`) — a separate BullMQ `Worker` process
  that consumes the queue and drives the loop above.
- Wired `POST /tickets` to actually call `enqueueTicket(...)` — previously it
  created the DB rows and queued nothing, so the worker had no way to find
  new tickets.

### Key decisions
- **Week 2 executes every tool immediately, including `issue_refund`.** The
  approval gate that intercepts money-moving calls *before* execution is
  explicitly Week 3 scope — not bolted on early, so the agent loop itself
  gets proven correct first.
- `issueRefund`'s `UPDATE` is conditional
  (`WHERE id = $1 AND status <> 'refunded'`), so two concurrent calls can't
  both succeed — the second matches zero rows. The database enforces
  single-execution here; explicit idempotency keys are a Week 3 addition on
  top of this, not a replacement for it.
- Tools return `{ ok, data }` / `{ ok: false, error }` instead of throwing
  (`src/tools/types.ts`). A failed tool result is fed back to the model,
  which can reason about it ("order not found — ask the customer to confirm
  the order number") instead of the whole run dying on an exception.
- Refund policy is **re-checked inside `issueRefund` itself**, not trusted
  from the model's earlier `check_refund_policy` call. The model could
  hallucinate eligibility, or order state could change between the check and
  the execution — the gate that matters is the one at the point of
  execution, not the one earlier in the conversation.
- `enqueueTicket` runs *after* the DB transaction commits, not inside it.
  The ticket/run rows are the source of truth; if Redis is unreachable the
  ticket still exists (recorded as an `enqueue_failed` audit_log entry)
  instead of vanishing because a queue write failed.

### Bugs hit
- **`.env` got corrupted by a paste that duplicated the whole template**
  instead of replacing it — the file ended up with two `REDIS_URL=` lines,
  the second one blank. `dotenv` parses top-to-bottom into an object before
  assigning to `process.env`, so the *last* line wins — `REDIS_URL` was
  silently `""` even though `grep` on the raw file found the real value on
  an earlier line. Symptom was `ioredis` retrying `ECONNREFUSED` forever
  (no bounded retry/timeout in the default client config), which looked like
  a network problem and wasn't. Diagnosed by printing
  `process.env.REDIS_URL` from inside Node instead of trusting a `grep` on
  the file — the file and what Node actually loads are not the same
  question. Fixed by rewriting `.env` clean.
- After that fix, Redis auth failed with `WRONGPASS` — the Upstash token
  pasted into `.env` doesn't match the one on the dashboard (likely a
  partial copy). **Needs a fresh copy from Upstash — currently blocked on
  this.**

### Switched the LLM provider: Claude → Gemini
The agent loop was originally written against Anthropic's SDK. Switched to
Google's Gemini free tier because the Claude API is pay-as-you-go and this is
a student project with no budget — the free tier requires no credit card.
`CLAUDE.md` already listed "Claude **or** Gemini" as acceptable, so this was
a planned fork rather than scope creep.

What the switch actually cost:
- `src/agent/toolSchemas.ts` — rewritten. Anthropic uses `input_schema` +
  `strict: true`; Gemini uses `FunctionDeclaration[]` with
  `parametersJsonSchema`. Same JSON Schema underneath, different wrapper.
- `src/agent/orchestrator.ts` — rewritten. The conversation model differs:
  Anthropic returns `tool_use` content blocks and takes `tool_result` blocks
  back; Gemini exposes `response.functionCalls` and takes `functionResponse`
  parts, with history carried in a `contents[]` array that must echo the
  model's own turn back verbatim.
- **Everything else was untouched.** The three tools, the queue, the worker,
  the schema, and the API are all provider-agnostic — they never knew which
  LLM was calling them. That separation is why the swap was two files instead
  of a rewrite, and it's the strongest argument for the way the tool layer
  was factored.
- Removed the `@anthropic-ai/sdk` dependency; added `@google/genai`.

Model defaults to `gemini-2.5-flash` (free tier, highest daily request cap),
overridable via `GEMINI_MODEL` without a code change.

### Verification scripts
Two runnable smoke tests, both of which work without an LLM key. They exist
so that when the agent later does something unexpected, the first question —
*is it the tools or the model?* — has an immediate answer.

`npm run verify:tools` — 15 checks, all passing. Exercises the three tools
directly against Postgres:
- policy verdicts for delivered / already-refunded / cancelled / unshipped
- over-amount, negative amount, and blank-reason refunds all rejected
- policy re-checked at execution time (an ineligible order is blocked even
  when `issueRefund` is called directly, bypassing the model entirely)
- **a second refund on the same order is rejected, and exactly one
  `refund_issued` audit entry exists afterwards** — the rejection is a real
  block, not a silent no-op that still logged
- destructive by design; prints a re-seed reminder on exit

`npm run verify:queue` — 6 checks, all passing. Producer side only:
- repeat enqueues of the same run collapse to one job (the `jobId` scheme)
- job id derivation, payload shape, retry config
- cleans up its own scratch job, safe against a live queue

### End-to-end plumbing verified (without the LLM)
Ran the whole path with `GEMINI_API_KEY` deliberately unset:
`POST /tickets` → row in Postgres → job `run-1` in Redis with the right
payload → worker consumed it → failed with a clear, actionable message.

Two things this confirmed that are easy to assume and worth actually seeing:
- **BullMQ retried exactly 3 times** with backoff, matching `attempts: 3`.
- The run ended `failed` with `completed_at` set, and the audit log captured
  *every* attempt — three `run_started` → `run_failed` pairs, not just the
  final state. Append-only means full forensic history, which is the whole
  point of the table.

Also worth noting: a missing API key fails the *run*, not the worker process.
The Gemini client is constructed lazily inside the loop for exactly this
reason — one misconfigured run shouldn't take down the consumer.

### Status: blocked / pending
- [x] `REDIS_URL` — fixed with a fresh Upstash token, verified `PING → PONG`
      plus a real set/get round trip
- [x] Tools verified independently (15/15)
- [x] Queue producer + consumer plumbing verified (6/6, plus the live run above)
- [ ] `GEMINI_API_KEY` not yet set — the only remaining blocker
      (free, no card: https://aistudio.google.com/apikey)
- [ ] Once set: the real end-to-end run — Gemini actually calling
      `lookup_order` → `check_refund_policy` → `issue_refund`, with
      `agent_steps` rows appearing and the run reaching `completed`

---

## Next — Week 3: Approval Gate + Idempotent Execution
- Intercept `issue_refund` before execution: write to `approvals` instead of
  running it immediately, set the run to `awaiting_approval`.
- `POST /approvals/:id/approve` and `/reject` to resume a paused run.
- Explicit idempotency keys on the refund execution path, on top of the
  conditional-`UPDATE` guard already in place.
