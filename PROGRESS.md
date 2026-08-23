# Progress Log

Running engineering log, week by week: what was built, why, what broke, and
how it got fixed. Kept separate from README.md — this is the working log,
README is the pitch. Dates are IST.

## Topic Index

The week sections below are chronological — good for "what happened," slow
for "why did we do X." This index is for the second question: each line
jumps straight to the decision, wherever it lives below.

**The approval gate** (the point of the project)
- [Money-moving actions stop and wait for a human](#approval-gate)
- [The gate keys off the tool name, not the model's self-report](#gate-on-tool-name)
- [What was approved is what runs — never a re-asked action](#approved-action-executes)
- [A paused run survives the worker dying](#durable-pause)
- [One verdict per approval, enforced by a conditional UPDATE](#verdict-race)

**Money & correctness**
- [Money handled as strings, never floats](#money-as-string)
- [Refund policy re-checked at execution time, not trusted from the model](#policy-recheck)
- [Duplicate refund blocked by a conditional UPDATE](#conditional-update)

**Idempotency & the job queue**
- [The idempotency key is the approval id](#key-is-approval)
- [A retry of a succeeded refund is a success, not an error](#retry-returns-original)
- [Policy is re-checked after the key is claimed, not before](#claim-before-check)
- [ON CONFLICT DO UPDATE, not DO NOTHING — it takes the row lock](#conflict-do-update)
- [jobId keyed on the run id — a duplicate POST can't spawn two runs](#jobid-dedup)
- [Retries are safe only because refunds are idempotency-keyed](#retry-safety)

**Audit trail**
- [audit_log is append-only at the database level, not app discipline](#audit-append-only)
- [Ticket + run + audit row written in one transaction](#one-transaction)
- [Enqueue runs after commit, not inside the transaction](#enqueue-after-commit)

**Agent loop & tools**
- [Tools return {ok, data} instead of throwing](#tool-result-contract)
- [Tool schema is a contract with the model, not a security boundary](#dispatcher-revalidate)
- [Switching LLM providers cost 2 files, not a rewrite](#provider-swap)

**Testing strategy**
- [Two smoke tests that work without an LLM key](#verification-scripts)
- [Full plumbing proven before ever calling a real model](#plumbing-before-llm)

**Bugs worth retelling**
- [A ticket returned 201 and then silently never ran](#jobid-collision)
- [A test failed because JSONB is not JSON](#jsonb-key-order)

*Week 4 will add: the trace viewer, deploy, the case-study README.*

---

## Week 1 — Foundation (2026-08-18 → 2026-08-19)

### Built
- Postgres schema (`src/db/migrate.ts`): 7 tables — `customers`, `orders`,
  `tickets`, `agent_runs`, `agent_steps`, `approvals`, `audit_log`. Status
  columns are `CHECK`-constrained against the enums in `src/types.ts`, and
  <a id="audit-append-only"></a>`audit_log` has Postgres `RULE`s that make
  `UPDATE`/`DELETE` on it silent no-ops — append-only enforced by the
  database, not application discipline.
- Express API (`src/index.ts`): `GET /health`, `POST /tickets`,
  `GET /tickets/:id/trace`.
- Seed script (`src/db/seed.ts`) — 5 customers, 10 orders, 7 tickets,
  deliberately spanning edge cases: already-refunded, cancelled, high-value.
- Converted the initial JS scaffold to TypeScript (strict mode) before
  writing real logic, to match the stated stack and avoid a much more
  expensive conversion later.

### Key decisions
- <a id="money-as-string"></a>`orders.amount` is read back from Postgres as
  a **string**, typed that way on purpose (`src/types.ts`) — `pg` returns
  `DECIMAL` columns as strings to avoid float rounding on money. Casting
  straight to `Number` anywhere in the refund path is how a ₹0.01
  discrepancy gets in.
- <a id="one-transaction"></a>Ticket + `agent_runs` row + `ticket_received`
  audit log entry are written in one transaction (`POST /tickets`). A ticket
  with no run would sit invisible to the worker forever.
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
- <a id="dispatcher-revalidate"></a>Tool dispatcher (`src/agent/executeTool.ts`)
  — re-validates input even though the schemas are strict, because the
  schema is a contract with the model, not a security boundary; this is
  where untrusted input actually enters real code.
- <a id="jobid-dedup"></a>BullMQ ticket queue + Redis connection
  (`src/queue/`) — `jobId` is keyed on the run id (`run-${runId}`), so a
  duplicate `POST /tickets` can't spawn two runs for the same run record.
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
- <a id="retry-safety"></a>**Week 2 executes every tool immediately,
  including `issue_refund`.** The approval gate that intercepts
  money-moving calls *before* execution is explicitly Week 3 scope — not
  bolted on early, so the agent loop itself gets proven correct first.
- <a id="conditional-update"></a>`issueRefund`'s `UPDATE` is conditional
  (`WHERE id = $1 AND status <> 'refunded'`), so two concurrent calls can't
  both succeed — the second matches zero rows. The database enforces
  single-execution here; explicit idempotency keys are a Week 3 addition on
  top of this, not a replacement for it.
- <a id="tool-result-contract"></a>Tools return `{ ok, data }` /
  `{ ok: false, error }` instead of throwing (`src/tools/types.ts`). A
  failed tool result is fed back to the model, which can reason about it
  ("order not found — ask the customer to confirm the order number")
  instead of the whole run dying on an exception.
- <a id="policy-recheck"></a>Refund policy is **re-checked inside
  `issueRefund` itself**, not trusted from the model's earlier
  `check_refund_policy` call. The model could hallucinate eligibility, or
  order state could change between the check and the execution — the gate
  that matters is the one at the point of execution, not the one earlier in
  the conversation.
- <a id="enqueue-after-commit"></a>`enqueueTicket` runs *after* the DB
  transaction commits, not inside it. The ticket/run rows are the source of
  truth; if Redis is unreachable the ticket still exists (recorded as an
  `enqueue_failed` audit_log entry) instead of vanishing because a queue
  write failed.

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

<a id="provider-swap"></a>
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

<a id="verification-scripts"></a>
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

<a id="plumbing-before-llm"></a>
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
- [x] `GEMINI_API_KEY` set — see the real end-to-end run below

### End-to-end run with Gemini actually calling tools
`POST /tickets` with `{"customer_id":1,"order_id":1,"message":"This item
arrived broken and I want a refund."}` (order 1: delivered, $49.99,
eligible). The worker picked up job `run-2` and Gemini drove the loop with
no scripting or forced tool order:

1. `lookup_order` (order 1) → confirmed delivered, $49.99, age 0 days
2. `check_refund_policy` (order 1) → eligible, reasons: within the 30-day
   window and status is `delivered`
3. `issue_refund` (order 1, $49.99, reason: "item arrived damaged") →
   refund recorded
4. a final no-tool step summarizing what it did and why

Run reached `status: completed`. `audit_log` for the run, in order:
`ticket_received` → `run_started` (records the model name,
`gemini-2.5-flash`) → `refund_issued` → `run_completed`. `agent_steps` has
one row per tool call (`step_order` 1–3) plus the closing reasoning-only
step (4), each with `tool_called`, `input`, `output`, and `reasoning`
populated. `amount` in every payload is a string end to end, never a float.

This closes Week 2: the model chooses which tools to call and in what
order — nothing in the orchestrator hardcodes the sequence — and every
choice is logged immutably before, during, and after execution.

**Not addressed yet, by design:** this run's refund is money-moving and
executed immediately, with no approval step. That's the Week 3 gap —
intercepting `issue_refund` before execution and routing it through
`approvals` instead.

---

## Week 3 — Approval Gate + Idempotent Execution (2026-08-23)

The week the project stopped being "an agent that calls tools" and became
"an agent that isn't allowed to move money on its own."

### Built
- <a id="approval-gate"></a>**The approval gate** (`src/agent/orchestrator.ts`)
  — money-moving tool calls no longer execute. The run suspends: an
  `approvals` row records the exact proposed action, the conversation is
  persisted, and run + ticket both move to `awaiting_approval`.
- <a id="durable-pause"></a>**Durable pause/resume** — `agent_runs.conversation_state`
  holds the model conversation, so a *different* worker process can pick the
  run back up mid-thought. The pause survives the worker dying.
- <a id="refunds-table"></a>**`refunds` table** with a UNIQUE `idempotency_key`,
  and `issueRefund` rewritten around it.
- **Approval endpoints** — `GET /approvals` (the review queue),
  `POST /approvals/:id/approve`, `POST /approvals/:id/reject`.
- Decision state machine extracted to `src/approvals/decide.ts` so the code
  that decides whether money may move is testable without HTTP.
- Ticket status wired through the lifecycle — nothing had been setting it:
  `processing` → `awaiting_approval` → `resolved`/`rejected`, back to `open`
  if the run fails.
- `npm run queue:clear`, and `npm run verify:approvals` (12 checks).

### Key decisions
- <a id="gate-on-tool-name"></a>**The gate keys off the tool name, decided in
  our code — not off anything the model reports about itself.** A model that
  has been talked into refunding still cannot execute; it can only ever
  *request*. Any design where the model asserts its own confidence or
  risk level is one prompt injection away from being no gate at all.
- <a id="approved-action-executes"></a>**What was approved is what runs.** On
  resume the action executed is the one stored on the approval row, not a
  fresh one asked of the model. A human approved a specific order and a
  specific amount; re-prompting could return something else, and the
  approval would then be authorising an action nobody reviewed.
- <a id="key-is-approval"></a>**The idempotency key is `approval-${id}`** —
  one human decision authorises exactly one payout, however many times the
  job is retried or redelivered. This is why `verify:approvals` cares so much
  that an approval can only be decided once: if a verdict could be recorded
  twice, the key derived from it would stop meaning what it claims to.
- <a id="retry-returns-original"></a>**A retry of a succeeded refund is a
  success, not an error.** The conditional `UPDATE` already prevented double
  payment, but it could only ever answer "no rows matched" — so a caller
  retrying after a timeout was told its refund was *denied* when in fact it
  had gone through. Prevention was right; the reported outcome was wrong.
  Replaying an idempotency key now returns the stored result of the original
  attempt.
- <a id="claim-before-check"></a>**Policy is re-checked *after* the key is
  claimed, not before.** A replay of a finished refund must not be re-judged
  against state its own execution changed — the order is now `refunded`, so
  policy would call it ineligible and turn a safe retry back into a failure.
- <a id="conflict-do-update"></a>**`ON CONFLICT DO UPDATE`, not `DO NOTHING`.**
  `DO NOTHING` returns no row and takes no lock, so a concurrent duplicate
  sails past and tries to read a result the winning transaction hasn't
  committed yet. Assigning the column to itself is a no-op write that takes
  the row lock, so the loser blocks until the winner commits and then reads
  its result.
- <a id="verdict-race"></a>**The verdict is a conditional `UPDATE` on
  `status = 'pending'`**, so the database picks the winner of a race. Reading
  first and then updating would leave a window where two reviewers both
  believe they won — and each would enqueue a resume.
- **Both guards stay.** The idempotency key catches a replay of the *same*
  logical refund; the conditional `UPDATE` on `orders` catches a *different*
  refund racing for the same order. Two layers, two distinct mistakes.
- **Rejection requires a reason**, and the model is told plainly that the
  action was refused and must not be retried — otherwise its closing summary
  cheerfully reports a refund that never happened.
- **`completed_at` stays NULL while paused.** The run is suspended, not
  finished; stamping an end time on it would be a lie the trace viewer would
  faithfully repeat.

### Bugs hit
- <a id="jobid-collision"></a>**A ticket returned 201 and then silently never
  ran.** The run sat at `pending` forever with no steps and nothing anywhere
  recording a failure. Cause: `jobId` is `run-${runId}`, and BullMQ counts
  *retained completed and failed* jobs toward id uniqueness, not just live
  ones — it returns the existing job instead of adding. Meanwhile `db:seed`
  truncates with `RESTART IDENTITY`, so run ids restart at 1 and collide with
  yesterday's corpses. The dedup that protects against double-refunds was
  swallowing legitimate new work. Diagnosed by reading the job out of Redis
  and finding a `failedReason` from the previous day. Fixed by keeping the
  live-duplicate case silent (that's the feature) and making a
  terminal-state collision throw, which `POST /tickets` already knows how to
  record as `enqueue_failed`. Added `npm run queue:clear`, since resetting
  the database without resetting the queue leaves two halves of one system
  disagreeing about what exists.
- **`verify:queue` claimed to be safe against a live queue and wasn't.** Its
  first checks asserted on `getWaitingCount()`, which reads 0 when a running
  worker pulls the scratch job before the next line executes. Now asserts by
  job id.
- **A paused run logged "run completed".** The BullMQ job had genuinely
  succeeded — pausing isn't a failure — but the run was parked waiting on a
  human, which is close to the opposite. The loop now returns its real
  terminal state and the worker logs that.
- <a id="jsonb-key-order"></a>**A test failed because JSONB is not JSON.**
  Comparing a round-tripped refund result with `JSON.stringify` reported a
  mismatch on identical values: Postgres normalizes object key order on
  storage (shortest key first, then bytewise). The code was right and the
  test was wrong — it now compares field by field.

### Verified
`npm run verify:approvals` — 12 checks. Validation, unknown approvals, and
the transitions that would otherwise only surface in production (an approved
action cannot later be rejected; a failed validation leaves the approval
pending). The last group fires three approvals simultaneously on separate
connections and asserts exactly one wins, the losers report
`already_decided` rather than crashing, and the audit log ends with exactly
one entry.

`npm run verify:tools` — now 19 checks. Adds: a refund with no idempotency
key is refused outright; replaying a key succeeds and returns the *original*
result; a different refund on an already-refunded order is still rejected;
exactly one row actually paid out.

**Live end-to-end, both paths.** Approved: ticket → `lookup_order` →
`check_refund_policy` → `issue_refund` **intercepted** (run and ticket
`awaiting_approval`, `completed_at` NULL, order untouched) → approved via
API → resumed in the worker → refund executed → model's closing summary
correctly describes the refund. A double-click on approve during this
returned 409. Rejected: same up to the gate, then rejected with a reason →
resumed → nothing executed → **order 1 still `delivered`, no `refunds` row**
→ the model's summary correctly explains the refusal instead of inventing a
refund.

Audit log for the approved run, in order: `ticket_received` → `run_started`
→ `approval_requested` → `approval_granted` → `run_resumed` →
`refund_issued` → `action_executed` → `run_completed`. For the rejected run:
`… → approval_rejected → run_resumed → action_rejected → run_completed`.

---

## Next — Week 4: Trace Viewer + Deploy
- The dashboard: submit a ticket, watch steps stream in, act on the approval
  queue, see the outcome. Per CLAUDE.md this is what actually gets judged.
- Deploy to a host with long-running workers (Render/Railway — not
  serverless, BullMQ needs a persistent process).
- Demo video as a fallback for when the free tier sleeps.
- README rewritten as a case study: problem → architecture → what was cut.

### Known gaps, deliberately
- **Confidence-based gating isn't built.** The gate currently triggers on
  money-moving tools only. Low-confidence gating needs a confidence signal
  that isn't just the model marking its own homework, which is a design
  problem rather than a coding one — see [the gate rationale](#gate-on-tool-name).
- No auth on the approval endpoints. `reviewed_by` is whatever the caller
  claims. Fine for a single-tenant demo, not for anything real.
