import { describe, it, expect } from 'vitest';
import { SingleFlight } from '../../../src/oauth/singleFlight.js';

describe('SingleFlight', () => {
  it('dedupes concurrent calls: 100 callers → 1 underlying invocation', async () => {
    const sf = new SingleFlight<number>();
    let calls = 0;
    const fn = async (): Promise<number> => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return 42;
    };
    const results = await Promise.all(Array.from({ length: 100 }, () => sf.run(fn)));
    expect(calls).toBe(1);
    expect(results.every((r) => r === 42)).toBe(true);
  });

  it('allows new invocations after the previous one resolved', async () => {
    const sf = new SingleFlight<number>();
    let calls = 0;
    const fn = async (): Promise<number> => {
      calls++;
      return calls;
    };
    expect(await sf.run(fn)).toBe(1);
    expect(await sf.run(fn)).toBe(2);
    expect(calls).toBe(2);
  });

  it('clears in-flight on rejection so the next caller can retry', async () => {
    const sf = new SingleFlight<number>();
    let attempts = 0;
    const fn = async (): Promise<number> => {
      attempts++;
      if (attempts === 1) throw new Error('first attempt fails');
      return 99;
    };
    await expect(sf.run(fn)).rejects.toThrow('first attempt fails');
    expect(sf.isInflight()).toBe(false);
    expect(await sf.run(fn)).toBe(99);
    expect(attempts).toBe(2);
  });

  it('propagates the same rejection to all concurrent callers', async () => {
    const sf = new SingleFlight<number>();
    const fn = async (): Promise<number> => {
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('boom');
    };
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => sf.run(fn)));
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });
});
