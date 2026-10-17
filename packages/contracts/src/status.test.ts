import { describe, expect, it } from 'vitest';
import {
  CANCELLABLE_STATUSES,
  EMAIL_STATUS,
  canTransition,
  displayStatus,
  sourcesFor,
  summarizeRecipients,
} from './status';

describe('email state machine', () => {
  it('final states have no outgoing transitions except unknown resolution', () => {
    expect(canTransition('submitted', 'queued')).toBe(false);
    expect(canTransition('cancelled', 'queued')).toBe(false);
    expect(canTransition('submission_unknown', 'submitted')).toBe(true);
    expect(canTransition('submission_unknown', 'submitting')).toBe(false);
  });

  it('cannot cancel after hand-off started', () => {
    expect(CANCELLABLE_STATUSES).not.toContain('submitting');
    expect(canTransition('submitting', 'cancelled')).toBe(false);
    expect(sourcesFor('cancelled').sort()).toEqual([...CANCELLABLE_STATUSES].sort());
  });

  it('a timeout during submitting never transitions directly back to submitting', () => {
    expect(canTransition('submitting', 'submitting')).toBe(false);
    expect(canTransition('submitting', 'submission_unknown')).toBe(true);
  });

  it('every state is defined', () => {
    for (const s of EMAIL_STATUS) expect(sourcesFor(s)).toBeDefined();
  });
});

describe('recipient aggregation', () => {
  const r = (
    status: 'submitted' | 'rejected' | 'suppressed',
    d?: { delivered?: boolean; bounced?: boolean; complained?: boolean },
  ) => ({
    status,
    deliveredAt: d?.delivered ? '2026-01-01T00:00:00Z' : null,
    bouncedAt: d?.bounced ? '2026-01-01T00:00:00Z' : null,
    complainedAt: d?.complained ? '2026-01-01T00:00:00Z' : null,
  });

  it('counts mixed outcomes independently', () => {
    const s = summarizeRecipients([
      r('submitted', { delivered: true }),
      r('submitted', { bounced: true }),
      r('rejected'),
      r('suppressed'),
      r('submitted', { delivered: true, complained: true }),
    ]);
    expect(s).toMatchObject({
      total: 5,
      submitted: 3,
      rejected: 1,
      suppressed: 1,
      delivered: 2,
      bounced: 1,
      complained: 1,
    });
  });

  it('does not report delivered when only some recipients were delivered', () => {
    const s = summarizeRecipients([r('submitted', { delivered: true }), r('submitted')]);
    expect(displayStatus('submitted', s)).toBe('partially_delivered');
  });

  it('keeps an earlier delivery visible when a complaint arrives later', () => {
    const s = summarizeRecipients([r('submitted', { delivered: true, complained: true })]);
    expect(s.delivered).toBe(1);
    expect(s.complained).toBe(1);
  });

  it('only shows delivered when all submitted recipients were delivered', () => {
    const s = summarizeRecipients([
      r('submitted', { delivered: true }),
      r('submitted', { delivered: true }),
    ]);
    expect(displayStatus('submitted', s)).toBe('delivered');
  });
});
