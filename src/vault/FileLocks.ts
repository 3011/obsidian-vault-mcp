export class FileLocks {
  private readonly tails = new Map<string, Promise<void>>();

  async withLock<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
    const normalized = [...new Set(keys)].sort();
    return this.withLockAt(normalized, 0, operation);
  }

  private async withLockAt<T>(keys: string[], index: number, operation: () => Promise<T>): Promise<T> {
    const key = keys[index];
    if (!key) return operation();

    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, previous.then(() => current, () => current));

    await previous.catch(() => undefined);
    try {
      return await this.withLockAt(keys, index + 1, operation);
    } finally {
      release();
      if (this.tails.get(key) === current) {
        this.tails.delete(key);
      }
    }
  }
}
