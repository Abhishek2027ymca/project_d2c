import { Badge } from './Badge';
import { ApprovalCard } from './ApprovalCard';
import type { AgentStep, Trace as TraceData } from '../types';

function isGate(step: AgentStep): boolean {
  return Boolean(step.output && typeof step.output === 'object' && 'intercepted' in step.output);
}

function stepClass(step: AgentStep): string {
  if (isGate(step)) return 'gate';
  const out = step.output as { ok?: boolean; executed?: boolean } | null;
  if (out && out.ok === false) return 'failed';
  if (out && out.executed === false) return 'failed';
  if (step.tool_called === null) return 'done';
  return '';
}

function label(step: AgentStep): string {
  if (step.tool_called === null) return 'final summary';
  if (isGate(step)) return `${step.tool_called} — held at gate`;
  return step.tool_called;
}

export function Trace({ trace, onDecided }: { trace: TraceData; onDecided: () => void }) {
  const pending = trace.approvals.find((a) => a.status === 'pending');

  return (
    <div>
      <div className="trace-head">
        <div className="row" style={{ marginBottom: 6 }}>
          <Badge status={trace.run?.status ?? null} />
          <span className="step-n">
            ticket #{trace.ticket.id}
            {trace.ticket.order_id !== null && ` · order #${trace.ticket.order_id}`}
          </span>
        </div>
        <div className="quote">{trace.ticket.message}</div>
      </div>

      {pending && <ApprovalCard approval={pending} onDecided={onDecided} />}

      {trace.steps.length === 0 ? (
        <p className="notice">
          {trace.run ? 'Waiting for the agent to pick this up…' : 'No run for this ticket.'}
        </p>
      ) : (
        <ol className="steps">
          {trace.steps.map((step) => (
            <li key={step.id} className={`step ${stepClass(step)}`}>
              <div className="step-head">
                <span className="step-tool">{label(step)}</span>
                <span className="step-n">step {step.step_order}</span>
              </div>

              {step.reasoning && <p className="reasoning">{step.reasoning}</p>}

              {step.input !== null && (
                <details>
                  <summary>input</summary>
                  <pre>{JSON.stringify(step.input, null, 2)}</pre>
                </details>
              )}
              {step.output !== null && (
                <details>
                  <summary>output</summary>
                  <pre>{JSON.stringify(step.output, null, 2)}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}

      {trace.approvals.filter((a) => a.status !== 'pending').map((a) => (
        <p key={a.id} className="notice">
          {a.proposed_action.tool} was <strong>{a.status}</strong>
          {a.reviewed_by && ` by ${a.reviewed_by}`}
          {a.reason && ` — "${a.reason}"`}
        </p>
      ))}
    </div>
  );
}
