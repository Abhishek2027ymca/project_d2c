# Project: AI Support-Ops Agent Platform

## Problem Statement
AI agents that take real actions (refunds, order changes) are risky in production —
they can hallucinate a refund, retry the same action twice, or act with zero audit
trail. Most demo/student agent projects skip this: they call an LLM and print an
answer. This project solves it for D2C/e-commerce support specifically: an agent
that reads a ticket, uses tools to check order/refund data, decides an action —
but if the action moves money or confidence is low, it stops and waits for human
approval before executing. Every step is logged immutably. Retries can't double-refund
(idempotency). The approval gate + audit trail + idempotent execution is the core
differentiator — not "I called an LLM API" but "I built a system safe enough to run
in production."

## Timeline
~1 month for a working core MVP, resume-ready. Designed to extend later (see
"Deferred" section) — do NOT let scope creep into the 1-month build.

## Tech Stack
- Node.js + TypeScript
- PostgreSQL with pgvector extension (no separate vector DB — justified by scale)
- Redis + BullMQ (job queue)
- Docker Compose (local multi-service orchestration)
- Claude or Gemini API for the agent's tool-calling loop
- Simple React/Next.js frontend for the trace viewer (the demo UI)

## Architecture
Single tenant only for MVP.
- **API Gateway**: auth, rate limiting, ticket ingestion endpoint
- **Orchestrator**: agent planning loop — reads ticket, decides which tool(s) to call
- **Worker(s)**: pull jobs from BullMQ, execute tool calls, write results
- **Trace Viewer (frontend)**: submit ticket → watch agent steps stream in →
  see approval queue → see final outcome + audit log

Flow: ticket arrives → queued → orchestrator picks up job → agent calls tools
(order lookup, refund policy check, issue refund) → if action is money-moving or
confidence is low → goes to approval_queue table, execution pauses → human
approves/rejects via dashboard → on approve, worker executes with idempotency key
→ audit log entry written at every step.

## MVP Scope (build this, nothing more, in the 1 month)
- Single tenant (no multi-tenancy yet)
- Exactly 3 tools: order lookup, refund policy check, issue refund
- Idempotent execution (idempotency keys on any money-moving action)
- Human-in-the-loop approval gate for money-moving / low-confidence actions
- Append-only audit log for every step
- Trace viewer dashboard (submit ticket → live step view → approval queue → outcome)
- Seeded demo data (15-20 fake orders/customers/tickets) so the deployed demo
  isn't empty

## Explicitly Deferred (mention in README as "next steps", do not build now)
- Multi-tenancy / tenant isolation
- Semantic caching for repeated questions
- Eval suite scoring agent decisions against a labelled set
- Load testing / throughput benchmarks
- Observability stack (Prometheus/Grafana)
- Kafka or any heavier message broker (BullMQ + Redis is the deliberate,
  defensible choice at this scale — do not "upgrade" this without a real reason)

## Rough DB Schema (adjust as needed, this is a starting sketch)
- customers (id, name, email)
- orders (id, customer_id, status, amount, created_at)
- tickets (id, customer_id, order_id, message, status, created_at)
- agent_runs (id, ticket_id, status, started_at, completed_at)
- agent_steps (id, run_id, step_order, tool_called, input, output, reasoning, timestamp)
- approvals (id, run_id, proposed_action, status [pending/approved/rejected], reviewed_by, reviewed_at)
- audit_log (id, run_id, event_type, payload, timestamp) — append-only, never updated

## Deployment / Showcase Plan (after core is working)
1. Seed realistic demo data
2. Deploy on a host that supports persistent background workers (Render/Railway
   for API+worker — NOT serverless, since BullMQ needs a long-running process),
   Neon/Supabase for Postgres (Supabase has pgvector built in), Upstash for Redis
3. Trace viewer dashboard is the actual "demo" — this is what gets judged, not
   the raw codebase
4. Record a 2-3 min Loom demo video as a reliable fallback in case live deploy
   is down/asleep
5. README written as a case study: problem → architecture → what was cut and why
   (this becomes the interview conversation)
6. One link from resume/portfolio to: live demo + video + GitHub repo

## Working Style / Constraints
- User (Abhishek) is a final-year B.Tech CE (Data Science) student prepping for
  campus placements, ~1 month timeline for this build
- Prefers to write and understand core logic himself (especially the idempotency
  handling and the agent decision loop) rather than have it fully generated —
  he needs to be able to defend design decisions in interviews
- Machine: Windows, Lenovo LOQ, 12GB RAM single stick — keep local dev footprint
  light (this is why Kafka was ruled out in favor of BullMQ+Redis)
- Other resume projects: DeployScout (AST-based static analysis CLI, npm
  published — his strongest current project), plus a React chat app and a
  Next.js AI mock-interview app that are considered weaker for backend-role
  positioning
