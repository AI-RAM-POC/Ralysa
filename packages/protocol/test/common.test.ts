// @ralysa/protocol/common: ids, traceparent and the problem body.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ERROR_CODES,
  Problem,
  Region,
  Sha256Hex,
  SpanId,
  TraceId,
  formatTraceparent,
  newSpanId,
  newTraceId,
  parseTraceparent,
  problemType,
  uuidv7,
} from '../src/common/index.js';

describe('ids', () => {
  it('accept lowercase hex of the right length only', () => {
    expect(TraceId.safeParse('4bf92f3577b34da6a3ce929d0e0e4736').success).toBe(true);
    expect(TraceId.safeParse('4BF92F3577B34DA6A3CE929D0E0E4736').success).toBe(false);
    expect(SpanId.safeParse('00f067aa0ba902b7').success).toBe(true);
    expect(SpanId.safeParse('00f067aa0ba902b').success).toBe(false);
    expect(Sha256Hex.safeParse('a'.repeat(64)).success).toBe(true);
    expect(Sha256Hex.safeParse('a'.repeat(63)).success).toBe(false);
  });

  it.each(['qa', 'qa-doha-1', 'me-central-1'])('Region accepts %s', (region) => {
    expect(Region.safeParse(region).success).toBe(true);
  });

  it.each(['Q', 'QA-DOHA', 'qa_doha', 'x'.repeat(41)])('Region refuses %s', (region) => {
    expect(Region.safeParse(region).success).toBe(false);
  });
});

describe('traceparent (W3C Trace Context)', () => {
  const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

  it('parses and formats the spec example', () => {
    const parsed = parseTraceparent(header);
    expect(parsed).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      sampled: true,
    });
    expect(formatTraceparent(parsed!)).toBe(header);
  });

  it.each([
    ['missing', undefined],
    ['garbage', 'hello'],
    ['version ff', header.replace(/^00/, 'ff')],
    ['all-zero trace id', `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`],
    ['all-zero span id', `00-4bf92f3577b34da6a3ce929d0e0e4736-${'0'.repeat(16)}-01`],
    ['upper case', header.toUpperCase()],
    ['extra fields on version 00', `${header}-extra`],
  ])('returns undefined for %s, so the caller starts a new trace', (_label, value) => {
    expect(parseTraceparent(value)).toBeUndefined();
  });

  it('accepts extra fields on a future version', () => {
    expect(parseTraceparent(`01-${header.slice(3)}-future`)?.sampled).toBe(true);
  });

  it('generates valid, non-zero ids', () => {
    for (let i = 0; i < 50; i++) {
      expect(TraceId.parse(newTraceId())).not.toBe('0'.repeat(32));
      expect(SpanId.parse(newSpanId())).not.toBe('0'.repeat(16));
    }
  });
});

describe('Problem (RFC 9457)', () => {
  it('includes audit_unavailable, with a stable URN type per code', () => {
    expect(ERROR_CODES).toContain('audit_unavailable');
    expect(problemType('audit_unavailable')).toBe('urn:ralysa:problem:audit_unavailable');
  });

  it('accepts a problem with an i18n key and extension members', () => {
    const body = {
      type: problemType('forbidden'),
      title: 'Forbidden',
      status: 403,
      code: 'forbidden',
      i18n_key: 'audit.error.not_platform_admin',
      trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
      extension: true,
    };
    expect(Problem.parse(body)).toEqual(body);
  });

  it('refuses a non-error status or an unknown code', () => {
    const base = { type: problemType('internal'), title: 'x', code: 'internal' };
    expect(Problem.safeParse({ ...base, status: 200 }).success).toBe(false);
    expect(Problem.safeParse({ ...base, status: 500, code: 'nope' }).success).toBe(false);
  });
});

describe('uuidv7 (RFC 9562 §5.7)', () => {
  it('encodes the millisecond timestamp, version 7 and the RFC variant', () => {
    const id = uuidv7(0x0192f0a07b3c);
    expect(id).toMatch(/^0192f0a0-7b3c-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(z.uuid().safeParse(id).success).toBe(true);
  });

  it('sorts by time and is unique within a millisecond', () => {
    const ids = [uuidv7(1_000), uuidv7(2_000), uuidv7(3_000)];
    expect([...ids].sort()).toEqual(ids);
    const same = new Set(Array.from({ length: 1000 }, () => uuidv7(5_000)));
    expect(same.size).toBe(1000);
  });

  it.each([-1, 1.5, 2 ** 48])('refuses the timestamp %s', (ms) => {
    expect(() => uuidv7(ms)).toThrow(RangeError);
  });
});
