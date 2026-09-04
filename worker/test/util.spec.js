import { describe, it, expect } from "vitest";
import { batched, BATCH_SIZE, handoffTag } from "../src/util.js";

describe("batched", () => {
  it("preserves input order across multiple batches", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const result = await batched(items, async (i) => i * 2, 8);
    expect(result).toEqual(items.map((i) => i * 2));
  });

  it("never runs more than `size` calls concurrently", async () => {
    const items = Array.from({ length: 17 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;
    await batched(
      items,
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
      8
    );
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });

  it("defaults to BATCH_SIZE (this account's real subrequest ceiling)", () => {
    expect(BATCH_SIZE).toBe(8);
  });
});

describe("handoffTag", () => {
  it("embeds the project id for later string-search dedup", () => {
    expect(handoffTag("abc-123")).toBe("[HANDOFF:abc-123]");
  });
});
