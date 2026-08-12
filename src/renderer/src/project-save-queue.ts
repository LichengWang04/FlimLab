/**
 * Serializes durable project writes. A later, smaller save must never publish
 * before an older, slower save and then be overwritten by it.
 */
export class ProjectSaveQueue {
  private tail: Promise<void> = Promise.resolve();

  public enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
