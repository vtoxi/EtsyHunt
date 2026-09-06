// Rate Limiter — enforces delays between page navigations

export class RateLimiter {
  constructor(delayMs = 8000) {
    this.delayMs = delayMs;
    this.lastAction = 0;
  }

  setDelay(ms) {
    this.delayMs = ms;
  }

  async wait() {
    const now = Date.now();
    const elapsed = now - this.lastAction;
    if (elapsed < this.delayMs) {
      await new Promise(r => setTimeout(r, this.delayMs - elapsed));
    }
    this.lastAction = Date.now();
  }

  async waitExtra(ms) {
    await new Promise(r => setTimeout(r, ms));
    this.lastAction = Date.now();
  }
}
