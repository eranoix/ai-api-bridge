import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../../../src/oauth/circuitBreaker.js';
import { CircuitBreakerOpenError } from '../../../src/oauth/types.js';

describe('CircuitBreaker', () => {
  it('stays closed on isolated failures, resets failure count on success', async () => {
    let clock = 1000;
    const cb = new CircuitBreaker({ threshold: 3, resetMs: 10_000, now: () => clock });
    await expect(cb.execute(async () => { throw new Error('x'); })).rejects.toThrow();
    await expect(cb.execute(async () => { throw new Error('x'); })).rejects.toThrow();
    expect(await cb.execute(async () => 'ok')).toBe('ok');
    expect(cb.state).toBe('closed');
    // 2 more failures (counter was reset): still closed.
    await expect(cb.execute(async () => { throw new Error('x'); })).rejects.toThrow();
    await expect(cb.execute(async () => { throw new Error('x'); })).rejects.toThrow();
    expect(cb.state).toBe('closed');
  });

  it('opens after threshold consecutive failures and blocks calls', async () => {
    let clock = 1000;
    const cb = new CircuitBreaker({ threshold: 3, resetMs: 10_000, now: () => clock });
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(async () => { throw new Error('x'); })).rejects.toThrow();
    }
    expect(cb.state).toBe('open');
    await expect(cb.execute(async () => 'never-runs')).rejects.toBeInstanceOf(
      CircuitBreakerOpenError,
    );
  });

  it('transitions to half-open after resetMs and closes on probe success', async () => {
    let clock = 1000;
    const cb = new CircuitBreaker({ threshold: 2, resetMs: 5000, now: () => clock });
    await expect(cb.execute(async () => { throw new Error('x'); })).rejects.toThrow();
    await expect(cb.execute(async () => { throw new Error('x'); })).rejects.toThrow();
    expect(cb.state).toBe('open');
    clock += 5001;
    expect(cb.state).toBe('half-open');
    expect(await cb.execute(async () => 'recovered')).toBe('recovered');
    expect(cb.state).toBe('closed');
  });

  it('half-open probe failure re-opens the breaker', async () => {
    let clock = 1000;
    const cb = new CircuitBreaker({ threshold: 2, resetMs: 5000, now: () => clock });
    await expect(cb.execute(async () => { throw new Error('x'); })).rejects.toThrow();
    await expect(cb.execute(async () => { throw new Error('x'); })).rejects.toThrow();
    clock += 5001;
    await expect(cb.execute(async () => { throw new Error('still bad'); })).rejects.toThrow('still bad');
    expect(cb.state).toBe('open');
  });
});
