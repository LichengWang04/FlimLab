/** Keep UI/compositor capacity available while libvips uses the remaining cores. */
export function recommendedImageThreadCount(availableThreads: number): number {
  if (!Number.isFinite(availableThreads) || availableThreads < 1) return 1;
  const threads = Math.max(1, Math.floor(availableThreads));
  const reservedForUi = threads >= 8 ? 2 : threads >= 2 ? 1 : 0;
  return Math.max(1, threads - reservedForUi);
}
