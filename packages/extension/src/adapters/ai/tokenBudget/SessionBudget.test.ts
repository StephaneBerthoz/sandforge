import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionBudget, type BudgetBroker, type BudgetThreshold } from './SessionBudget.js';

interface Recorded {
  sent: Array<{ type: string; payload: unknown }>;
  notices: Array<{ threshold: BudgetThreshold; percent: number }>;
}

function makeBroker(): { broker: BudgetBroker } & Recorded {
  const sent: Recorded['sent'] = [];
  const notices: Recorded['notices'] = [];
  const broker: BudgetBroker = {
    send: vi.fn((m) => sent.push({ type: m.type, payload: m.payload })),
    notify: vi.fn((threshold, state) => notices.push({ threshold, percent: state.percent })),
  };
  return { broker, sent, notices };
}

const u = (input: number, output: number, cacheRead = 0, cacheCreate = 0) => ({
  input,
  output,
  cacheRead,
  cacheCreate,
  total: input + output + cacheRead + cacheCreate,
});

describe('SessionBudget', () => {
  let broker: BudgetBroker;
  let sent: Recorded['sent'];
  let notices: Recorded['notices'];

  beforeEach(() => {
    ({ broker, sent, notices } = makeBroker());
  });

  it('initial state: zero usage, percent 0, state=ok', () => {
    const sb = new SessionBudget({ sessionId: 's1', budget: 1000 });
    const s = sb.getState();
    expect(s.used.total).toBe(0);
    expect(s.percent).toBe(0);
    expect(s.state).toBe('ok');
  });

  it('increment sums all 4 fields, cache tokens included', () => {
    const sb = new SessionBudget({ sessionId: 's', budget: 1000 });
    sb.increment(u(10, 5, 3, 2));
    expect(sb.getState().used.total).toBe(20);
    sb.increment(u(5, 5));
    const s = sb.getState();
    expect(s.used.total).toBe(30);
    expect(s.used.input).toBe(15);
    expect(s.used.output).toBe(10);
    expect(s.used.cacheRead).toBe(3);
    expect(s.used.cacheCreate).toBe(2);
  });

  it('state transitions: ok → warn → exceeded', () => {
    const sb = new SessionBudget({ sessionId: 's', budget: 100, broker });
    expect(sb.increment(u(50, 0)).state).toBe('ok');
    expect(sb.increment(u(35, 0)).state).toBe('warn'); // 85%
    expect(sb.increment(u(30, 0)).state).toBe('exceeded'); // 115%
  });

  it('gives the warning notice exactly once, at the first 80% crossing', () => {
    const sb = new SessionBudget({ sessionId: 's', budget: 100, broker });
    sb.increment(u(85, 0)); // crosses 80%
    sb.increment(u(5, 0));
    sb.increment(u(5, 0));
    expect(notices).toEqual([{ threshold: 'warn', percent: 85 }]);
  });

  it('gives the refusal notice once, however many calls breach or are refused', () => {
    const sb = new SessionBudget({ sessionId: 's', budget: 100, broker });
    sb.increment(u(85, 0));
    sb.increment(u(25, 0)); // 110%
    sb.increment(u(5, 0));
    expect(sb.preflight(50).allowed).toBe(false);
    expect(sb.preflight(50).allowed).toBe(false);
    expect(notices.map((n) => n.threshold)).toEqual(['warn', 'exceeded']);
  });

  it('announces only the refusal when one call jumps straight past 100%', () => {
    const sb = new SessionBudget({ sessionId: 's', budget: 100, broker });
    sb.increment(u(120, 0));
    sb.increment(u(1, 0));
    expect(notices.map((n) => n.threshold)).toEqual(['exceeded']);
  });

  it('preflight refuses when projectedTotal > budget and says so', () => {
    const sb = new SessionBudget({ sessionId: 's', budget: 100, broker });
    sb.increment(u(70, 0));
    const result = sb.preflight(35); // 70 + 35 = 105 > 100
    expect(result.allowed).toBe(false);
    expect(result.state.state).toBe('exceeded');
    expect(notices.map((n) => n.threshold)).toEqual(['exceeded']);
  });

  it('preflight allows when projectedTotal <= budget', () => {
    const sb = new SessionBudget({ sessionId: 's', budget: 100, broker });
    sb.increment(u(70, 0));
    const result = sb.preflight(25); // 95 <= 100
    expect(result.allowed).toBe(true);
    expect(notices).toEqual([]);
  });

  it('reset clears the count and re-arms the warning notice', () => {
    const sb = new SessionBudget({ sessionId: 's', budget: 100, broker });
    sb.increment(u(85, 0));
    sb.reset();
    expect(sb.getState().used.total).toBe(0);
    sb.increment(u(85, 0));
    expect(notices.map((n) => n.threshold)).toEqual(['warn', 'warn']);
  });

  it('resize keeps the count and re-arms the notices the new limit clears', () => {
    const sb = new SessionBudget({ sessionId: 's', budget: 100, broker });
    sb.increment(u(110, 0));
    expect(notices.map((n) => n.threshold)).toEqual(['exceeded']);

    sb.resize(1000);
    expect(sb.getState().used.total).toBe(110);
    expect(sb.getState().state).toBe('ok');
    expect(sent.at(-1)?.type).toBe('ai:budget:state');

    sb.increment(u(700, 0)); // 81%
    sb.increment(u(300, 0)); // 111%
    expect(notices.map((n) => n.threshold)).toEqual(['exceeded', 'warn', 'exceeded']);
  });

  it('resize to the current limit changes nothing and sends nothing', () => {
    const sb = new SessionBudget({ sessionId: 's', budget: 100, broker });
    sb.resize(100);
    expect(sent).toEqual([]);
  });

  it('refuses a limit that is not a positive number, at construction or resize', () => {
    expect(() => new SessionBudget({ sessionId: 's', budget: 0 })).toThrow(/positive/);
    const sb = new SessionBudget({ sessionId: 's', budget: 100 });
    expect(() => sb.resize(-5)).toThrow(/positive/);
    expect(sb.getState().budget).toBe(100);
  });

  it('reports to the sink connected last', () => {
    const sb = new SessionBudget({ sessionId: 's', budget: 100, broker });
    const later = makeBroker();
    sb.connect(later.broker);
    sb.increment(u(90, 0));
    expect(sent).toEqual([]);
    expect(later.sent.map((m) => m.type)).toEqual(['ai:budget:state']);
    expect(later.notices.map((n) => n.threshold)).toEqual(['warn']);
  });

  it('NaN guard — increment with NaN delta is ignored, state unchanged', () => {
    const sb = new SessionBudget({ sessionId: 's', budget: 100, broker });
    sb.increment(u(50, 0));
    sb.increment({ input: NaN, output: NaN, cacheRead: NaN, cacheCreate: NaN, total: NaN });
    expect(sb.getState().used.total).toBe(50);
  });

  it('sends only ai:budget:state to the webview, on every increment', () => {
    const sb = new SessionBudget({ sessionId: 's', budget: 100, broker });
    sb.increment(u(10, 0));
    sb.increment(u(80, 0));
    sb.increment(u(30, 0));
    sb.preflight(10);
    expect(sent.map((m) => m.type)).toEqual([
      'ai:budget:state',
      'ai:budget:state',
      'ai:budget:state',
    ]);
  });
});
