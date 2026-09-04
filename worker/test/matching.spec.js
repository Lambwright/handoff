import { describe, it, expect } from "vitest";
import { normalizeCompanyName, scoreMatch, rankMatches, HIGH_CONFIDENCE } from "../src/matching.js";

describe("normalizeCompanyName", () => {
  it("strips a trailing legal-entity suffix", () => {
    expect(normalizeCompanyName("Acme Millwork Ltd.")).toBe("ACME MILLWORK");
    expect(normalizeCompanyName("Acme Millwork Inc")).toBe("ACME MILLWORK");
    expect(normalizeCompanyName("Acme Millwork, LLC")).toBe("ACME MILLWORK");
  });

  it("leaves a name with no suffix alone (just cased/trimmed)", () => {
    expect(normalizeCompanyName("  Acme Millwork  ")).toBe("ACME MILLWORK");
  });

  it("falls back to the raw uppercased name if stripping would leave < 2 chars", () => {
    expect(normalizeCompanyName("Co")).toBe("CO");
  });
});

describe("scoreMatch", () => {
  it("scores an exact normalized match as 1", () => {
    expect(scoreMatch("Acme Millwork Ltd.", "ACME MILLWORK")).toBe(1);
  });

  it("scores unrelated names low", () => {
    expect(scoreMatch("Acme Millwork", "Zenith Construction")).toBeLessThan(0.2);
  });

  it("scores a subset name (e.g. shortened on the bid) highly via containment", () => {
    expect(scoreMatch("Acme", "Acme Millwork Group")).toBeGreaterThan(0.6);
  });

  it("is symmetric", () => {
    const a = scoreMatch("Acme Millwork", "Acme Millwork Group");
    const b = scoreMatch("Acme Millwork Group", "Acme Millwork");
    expect(a).toBeCloseTo(b, 5);
  });
});

describe("rankMatches", () => {
  const vendors = [
    { id: 1, name: "Acme Millwork Ltd.", is_active: true },
    { id: 2, name: "Zenith Construction", is_active: true },
    { id: 3, name: "Acme Millwork Group", is_active: false },
  ];

  it("ranks the best match first", () => {
    const ranked = rankMatches("Acme Millwork", vendors);
    expect(ranked[0].directory_id).toBe(1);
    expect(ranked[0].score).toBeGreaterThanOrEqual(HIGH_CONFIDENCE);
  });

  it("carries is_active through so callers can filter it", () => {
    const ranked = rankMatches("Acme Millwork", vendors);
    const inactive = ranked.find((r) => r.directory_id === 3);
    expect(inactive.is_active).toBe(false);
  });
});
