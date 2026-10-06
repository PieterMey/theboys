// Owned by track ② Level. Minimal binary min-heap over (int id, float key) with typed arrays; no dependency.
// Duplicate ids are allowed (lazy deletion: callers skip stale pops by comparing keys).

export class MinHeap {
  ids: Int32Array;
  keys: Float64Array;
  length = 0;

  constructor(capacity = 1024) {
    this.ids = new Int32Array(capacity);
    this.keys = new Float64Array(capacity);
  }

  clear(): void { this.length = 0; }

  push(id: number, key: number): void {
    if (this.length === this.ids.length) {
      const ids = new Int32Array(this.ids.length * 2); ids.set(this.ids); this.ids = ids;
      const keys = new Float64Array(this.keys.length * 2); keys.set(this.keys); this.keys = keys;
    }
    let pos = this.length++;
    const ids = this.ids, keys = this.keys;
    while (pos > 0) {
      const parent = (pos - 1) >> 1;
      const pk = keys[parent];
      if (key >= pk) break;
      ids[pos] = ids[parent]; keys[pos] = pk;
      pos = parent;
    }
    ids[pos] = id; keys[pos] = key;
  }

  /** key of the top element (call only when length > 0) */
  peekKey(): number { return this.keys[0]; }

  /** removes and returns the id with the smallest key (call only when length > 0); its key is in lastKey */
  lastKey = 0;
  pop(): number {
    const ids = this.ids, keys = this.keys;
    const top = ids[0];
    this.lastKey = keys[0];
    const n = --this.length;
    if (n > 0) {
      const id = ids[n], key = keys[n];
      let pos = 0;
      const half = n >> 1;
      while (pos < half) {
        let best = 2 * pos + 1;
        const right = best + 1;
        if (right < n && keys[right] < keys[best]) best = right;
        if (keys[best] >= key) break;
        ids[pos] = ids[best]; keys[pos] = keys[best];
        pos = best;
      }
      ids[pos] = id; keys[pos] = key;
    }
    return top;
  }
}
