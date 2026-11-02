import { describe, it, expect } from 'vitest';
import { autopilotAuditFitOf, planWriteGateOf } from './autopilotPlanGate.js';

describe('planWriteGateOf', () => {
  it('says the storage and the requests a plan would meet, from one read of the limits', () => {
    expect(
      planWriteGateOf(
        { totalRows: 32_982 },
        { verdict: 'exceeds', estimateMB: 64.5, remainingMB: 22, maxMB: 200 },
        { verdict: 'near', estimate: 4_000, remaining: 5_000, max: 15_000 },
      ),
    ).toEqual({
      records: 32_982,
      estimateMB: 64.5,
      remainingMB: 22,
      maxMB: 200,
      verdict: 'exceeds',
      apiRequests: { estimate: 4_000, remaining: 5_000, max: 15_000, verdict: 'near' },
    });
  });

  it('says why the target did not say, and names no room it was not told', () => {
    const gate = planWriteGateOf(
      { totalRows: 10 },
      { verdict: 'unread', estimateMB: 0.02, unread: 'REQUEST_LIMIT_EXCEEDED' },
      { verdict: 'unread', estimate: 2, unread: 'REQUEST_LIMIT_EXCEEDED' },
    );

    expect(gate).toEqual({
      records: 10,
      estimateMB: 0.02,
      verdict: 'unread',
      unread: 'REQUEST_LIMIT_EXCEEDED',
    });
  });
});

describe('autopilotAuditFitOf', () => {
  it('keeps the share, the bound asked and the records, never an id', () => {
    expect(
      autopilotAuditFitOf({ mode: { share: true, withinMB: 16 }, share: 0.26 }, 8_585, 32_982),
    ).toEqual({ module: 'autopilot', share: 0.26, withinMB: 16, kept: 8_585, inSource: 32_982 });
  });

  it('says a plan was capped, per object or for every one, with no share of its own', () => {
    const inSource = 100;
    expect(autopilotAuditFitOf({ mode: { caps: { Contact: 10 } } }, 40, inSource)).toEqual({
      module: 'autopilot',
      capped: true,
      kept: 40,
      inSource,
    });
    expect(autopilotAuditFitOf({ mode: { all: 10 } }, 40, inSource)).toMatchObject({
      capped: true,
    });
    expect(autopilotAuditFitOf({ mode: { share: true }, share: 1 }, 40, 100)).not.toHaveProperty(
      'capped',
    );
  });
});
