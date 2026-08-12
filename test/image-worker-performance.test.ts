import assert from "node:assert/strict";
import test from "node:test";

import { recommendedImageThreadCount } from "../src/main/image-worker-performance.ts";

test("image worker uses multiple cores while reserving UI capacity", () => {
  assert.equal(recommendedImageThreadCount(16), 14);
  assert.equal(recommendedImageThreadCount(8), 6);
  assert.equal(recommendedImageThreadCount(4), 3);
  assert.equal(recommendedImageThreadCount(2), 1);
  assert.equal(recommendedImageThreadCount(1), 1);
  assert.equal(recommendedImageThreadCount(Number.NaN), 1);
});
