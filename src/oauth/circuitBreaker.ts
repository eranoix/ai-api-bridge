import { CircuitBreakerOpenError } from './types.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening. */
  threshold: number;
  /** How long to stay open before allowing a probe call. */
  resetMs: number;
  /** Optional clock for tests. */
  now?: () => number;
}

/**
 * Minimal circuit breaker: trips after N consecutive failures, blocks all
 * calls during cool-down, allows ONE probe call after cool-down. A success
 * closes the circuit; a failure re-opens it for another cool-down period.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private probing = false;

  constructor(private readonly opts: CircuitBreakerOptions) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  get state(): CircuitState {
    if (this.openedAt === null) return 'closed';
    if (this.now() - this.openedAt >= this.opts.resetMs) return 'half-open';
    return 'open';
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state;

    if (state === 'open') {
      const retryAfter = this.opts.resetMs - (this.now() - (this.openedAt as number));
      throw new CircuitBreakerOpenError(Math.max(0, retryAfter));
    }

    if (state === 'half-open') {
      if (this.probing) {
        // Another probe is in flight: fail fast rather than amplify.
        throw new CircuitBreakerOpenError(0);
      }
      this.probing = true;
    }

    try {
      const result = await fn();
      this.failures = 0;
      this.openedAt = null;
      return result;
    } catch (err) {
      this.failures += 1;
      if (this.failures >= this.opts.threshold) {
        this.openedAt = this.now();
      }
      throw err;
    } finally {
      this.probing = false;
    }
  }
}
