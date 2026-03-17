import type { CircuitBreakerConfig, CircuitBreakerState } from '@sandforge/shared';

/**
 * Implements the circuit breaker pattern for Salesforce API calls.
 * Prevents cascading failures by temporarily blocking requests after repeated failures.
 */
export class CircuitBreaker {
  private state: CircuitBreakerState = 'closed';
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenSuccesses = 0;
  private halfOpenInFlight = 0;
  private config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = {
      failureThreshold: config?.failureThreshold ?? 5,
      resetTimeout: config?.resetTimeout ?? 60_000,
      halfOpenRequests: config?.halfOpenRequests ?? 1,
    };
  }

  /** Get the current circuit state */
  getState(): CircuitBreakerState {
    if (this.state === 'open' && this.shouldTransitionToHalfOpen()) {
      this.state = 'half_open';
      this.halfOpenSuccesses = 0;
    }
    return this.state;
  }

  /** Check if the circuit allows requests */
  canExecute(): boolean {
    const currentState = this.getState();
    if (currentState === 'closed') return true;
    if (currentState === 'half_open') {
      return this.halfOpenInFlight < this.config.halfOpenRequests;
    }
    return false;
  }

  /** Record a successful operation */
  recordSuccess(): void {
    if (this.state === 'half_open') {
      this.halfOpenSuccesses++;
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      if (this.halfOpenSuccesses >= this.config.halfOpenRequests) {
        this.reset();
      }
    } else {
      this.failureCount = 0;
    }
  }

  /** Record a failed operation */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half_open') {
      this.trip();
    } else if (this.failureCount >= this.config.failureThreshold) {
      this.trip();
    }
  }

  /** Manually trip (open) the circuit */
  trip(): void {
    this.state = 'open';
    this.lastFailureTime = Date.now();
  }

  /** Manually reset (close) the circuit */
  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.halfOpenSuccesses = 0;
    this.halfOpenInFlight = 0;
  }

  /** Get failure count */
  getFailureCount(): number {
    return this.failureCount;
  }

  /** Acquire a permit to execute in half-open state (checks canExecute + increments in-flight) */
  acquirePermit(): boolean {
    if (!this.canExecute()) return false;
    if (this.getState() === 'half_open') {
      this.halfOpenInFlight++;
    }
    return true;
  }

  /**
   * Release a permit (decrements in-flight counter).
   * Must only be called after a successful `acquirePermit()`.
   * Calling without a prior acquire is a no-op (counter is clamped to 0).
   */
  releasePermit(): void {
    this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
  }

  /** Get circuit breaker configuration */
  getConfig(): Readonly<CircuitBreakerConfig> {
    return { ...this.config };
  }

  private shouldTransitionToHalfOpen(): boolean {
    return Date.now() - this.lastFailureTime >= this.config.resetTimeout;
  }
}
