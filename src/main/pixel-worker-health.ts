export class PixelWorkerFailure extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "PixelWorkerFailure";
    this.cause = cause;
  }
}

export class PixelWorkerCircuitBreaker {
  private consecutiveFailures = 0;
  private tripped = false;

  get canCreatePool(): boolean {
    return !this.tripped;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= 2) this.tripped = true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  get failureCount(): number {
    return this.consecutiveFailures;
  }
}
