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
      if (this.inflight === promise) {
        this.inflight = null;
      }
    }
  }

  isInflight(): boolean {
    return this.inflight !== null;
  }
}
