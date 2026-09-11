import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionBudget, type BudgetBroker } from './SessionBudget.js';

function makeBroker(): { broker: BudgetBroker; sent: Array<{ type: string; payload: unknown }> } {
  const sent: Array<{ type: string; payload: unknown }> = [];
  const broker: BudgetBroker = {
    send: vi.fn((m) => sent.push({ type: m.type, payload: m.payload })),
  };
  return { broker, sent };
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
  let sent: Array<{ type: string; payload: unknown }>;

  beforeEach(() => {
    ({ broker, sent } = makeBroker());
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

  it('ai:budget:warn fires EXACTLY once per session at the first 80% crossing', () => {
    const sb = new SessionBudget({ sessionId: 's', budget: 100, broker });
    sb.increment(u(85, 0)); // crosses 80%
    sb.increment(u(5, 0));
    sb.increment(u(5, 0));
    sb.increment(u(5, 0));
    const warnCount = sent.filter((m) => m.type === 'ai:budget:warn').length;
    expect(warnCount).toBe(1);
  });

  it('ai:budget:exceeded fires on EVERY breach call (and every failing preflight)', () => {
    const sb = new SessionBudget({ sessionId: 's', budget: 100, broker });
    sb.increment(u(110, 0)); // 110% — exceeded #1
    sb.increment(u(5, 0)); // exceeded #2
    sb.preflight(50); // exceeded #3 (preflight refuses)
    const exceededCount = sent.filter((m) => m.type === 'ai:budget:exceeded').length;
    expect(exceededCount).toBeGreaterThanOrEqual(3);
  });

  it('preflight refuses when projectedTotal > budget', () => {
    const sb = new SessionBudget({ sessionId: 's', budget: 100, broker });
    sb.increment(u(80, 0));
    const result = sb.preflight(25); // 80 + 25 = 105 > 100
    expect(result.allowed).toBe(false);
    expect(result.state.state).toBe('exceeded');
    expect(sent.some((m) => m.type === 'ai:budget:exceeded')).toBe(true);
  });

  it('preflight allows when projectedTotal <= budget', () => {
    const sb = new SessionBudget({ sessionId: 's', budget: 100, broker });
    sb.increment(u(80, 0));
    const result = sb.preflight(15); // 95 < 100
    expect(result.allowed).toBe(true);
    expect(sent.some((m) => m.type === 'ai:budget:exceeded')).toBe(false);
  });

  it('reset clears state and warnFired (next 80% crossing fires warn again)', () => {
    const sb = new SessionBudget({ sessionId: 's', budget: 100, broker });
    sb.increment(u(85, 0));
    expect(sent.filter((m) => m.type === 'ai:budget:warn').length).toBe(1);
    sb.reset();
    expect(sb.getState().used.total).toBe(0);
    sb.increment(u(85, 0));
    expect(sent.filter((m) => m.type === 'ai:budget:warn').length).toBe(2);
  });

  it('budget=0 throws at construction', () => {
    expect(() => new SessionBudget({ sessionId: 's', budget: 0 })).toThrow(/positive/);
  });

  it('NaN guard — increment with NaN delta is ignored, state unchanged', () => {
    const sb = new SessionBudget({ sessionId: 's', budget: 100, broker });
    sb.increment(u(50, 0));
    sb.increment({ input: NaN, output: NaN, cacheRead: NaN, cacheCreate: NaN, total: NaN });
    expect(sb.getState().used.total).toBe(50);
  });

  it('ai:budget:state fires on EVERY increment (mini-bar live update)', () => {
    const sb = new SessionBudget({ sessionId: 's', budget: 1000, broker });
    sb.increment(u(10, 0));
    sb.increment(u(20, 0));
    sb.increment(u(30, 0));
    sb.increment(u(40, 0));
    sb.increment(u(50, 0));
    const stateMsgs = sent.filter((m) => m.type === 'ai:budget:state');
    expect(stateMsgs.length).toBe(5);
  });

  it('settingsKey on exceeded payload is the canonical key', () => {
    const sb = new SessionBudget({ sessionId: 's', budget: 100, broker });
    sb.increment(u(110, 0));
    const exceeded = sent.find((m) => m.type === 'ai:budget:exceeded');
    expect(exceeded).toBeDefined();
    const payload = exceeded!.payload as { settingsKey: string };
    expect(payload.settingsKey).toBe('sandforge.ai.tokenBudgetMaxPerSession');
  });
});
