export class AifBoundedCache<T> {
  private readonly entries = new Map<string, T>();
  readonly capacity: number;
  constructor(capacity = 8) { this.capacity = capacity; }
  get(key: string) {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }
  set(key: string, value: T) {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value as string);
  }
  clear() { this.entries.clear(); }
  get size() { return this.entries.size; }
}
