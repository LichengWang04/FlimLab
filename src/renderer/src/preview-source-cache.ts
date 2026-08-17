import { NegativeSession, Raster } from "../../core/index.ts";

export const PREVIEW_SOURCE_LIMIT = 3;
export const PREVIEW_MEMORY_BUDGET = 192 * 1024 * 1024;

interface SourceEntry {
  source: Raster;
  session?: NegativeSession;
  lastUsed: number;
}

/** Deterministic LRU: sources are bounded, and only the active source retains derived rasters. */
export class PreviewSourceCache {
  private readonly sources = new Map<string, SourceEntry>();
  private clock = 0;
  private activeId: string | null = null;
  private readonly sourceLimit: number;
  private readonly memoryBudget: number;

  constructor(
    sourceLimit = PREVIEW_SOURCE_LIMIT,
    memoryBudget = PREVIEW_MEMORY_BUDGET,
  ) {
    this.sourceLimit = sourceLimit;
    this.memoryBudget = memoryBudget;
  }

  register(id: string, source: Raster): void {
    this.sources.set(id, { source, lastUsed: ++this.clock });
    this.trim(id);
  }

  activate(id: string): { source: Raster; session: NegativeSession } | undefined {
    const entry = this.sources.get(id);
    if (entry === undefined) return undefined;
    if (this.activeId !== id) {
      for (const [cachedId, cached] of this.sources) {
        if (cachedId !== id) cached.session = undefined;
      }
      this.activeId = id;
    }
    entry.lastUsed = ++this.clock;
    entry.session ??= new NegativeSession(entry.source);
    this.trim(id);
    return { source: entry.source, session: entry.session };
  }

  release(id: string): void {
    this.sources.delete(id);
    if (this.activeId === id) this.activeId = null;
  }

  clear(): void {
    this.sources.clear();
    this.activeId = null;
  }

  has(id: string): boolean {
    return this.sources.has(id);
  }

  get size(): number {
    return this.sources.size;
  }

  get estimatedBytes(): number {
    let bytes = 0;
    for (const [id, entry] of this.sources) {
      bytes += entry.source.data.byteLength * (id === this.activeId && entry.session !== undefined ? 5 : 1);
    }
    return bytes;
  }

  private trim(protectedId: string): void {
    while (this.sources.size > this.sourceLimit || this.estimatedBytes > this.memoryBudget) {
      let oldest: [string, SourceEntry] | undefined;
      for (const candidate of this.sources) {
        if (candidate[0] === protectedId) continue;
        if (oldest === undefined || candidate[1].lastUsed < oldest[1].lastUsed) oldest = candidate;
      }
      if (oldest === undefined) break;
      this.sources.delete(oldest[0]);
    }
  }
}
