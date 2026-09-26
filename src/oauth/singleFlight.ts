/**
 * Single-flight (promise dedupe): callers of `run(fn)` while `fn` is pending
 * share the same Promise. Without it, concurrent expired-token requests would
 * all spend the same refresh_token and all but one would get an invalidated token.
 */
export class SingleFlight<T> {
  private inflight: Promise<T> | null = null;

  async run(fn: () => Promise<T>): Promise<T> {
    if (this.inflight) {
      return this.inflight;
    }
    const promise = (async () => fn())();
    this.inflight = promise;
    try {
      return await promise;
    } finally {
      // Always clear, even on rejection: the next call may need to retry.
      if (this.inflight === promise) {
        this.inflight = null;
      }
    }
  }

  /** Currently has an in-flight call. */
  isInflight(): boolean {
    return this.inflight !== null;
  }
}
