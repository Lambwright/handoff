import { describe, it, expect } from "vitest";
import { daysOverlap, aggregateWorkload, applyAffinity, sortForDisplay } from "../src/assignment.js";

describe("daysOverlap", () => {
  it("returns 0 when either range is missing", () => {
    expect(daysOverlap(null, "2026-01-01", "2026-01-01", "2026-02-01")).toBe(0);
  });

  it("returns 0 for non-overlapping ranges", () => {
    expect(daysOverlap("2026-01-01", "2026-01-31", "2026-03-01", "2026-03-31")).toBe(0);
  });

  it("computes the overlapping day count for overlapping ranges", () => {
    // Jan 15 - Feb 15 overlapping Feb 1 - Mar 1 => Feb 1 - Feb 15 = 14 days
    expect(daysOverlap("2026-01-15", "2026-02-15", "2026-02-01", "2026-03-01")).toBe(14);
  });

  it("handles one range fully containing the other", () => {
    expect(daysOverlap("2026-01-01", "2026-12-31", "2026-06-01", "2026-06-10")).toBe(9);
  });
});

describe("aggregateWorkload", () => {
  const newTimeline = { start_date: "2026-06-01", end_date: "2026-08-01" };
  // extractPm/extractValue/extractTimeline/extractStage read Procore-shaped
  // fields via procore-shapes.js's PROJECT adapters — this fixture matches
  // those field names (departments[0].id, the confirmed PM-assignment field;
  // total_value; start_date/completion_date).
  const activeProjects = [
    { id: 1, departments: [{ id: 10, name: "Alex PM" }], total_value: 100000, start_date: "2026-05-01", completion_date: "2026-07-01" },
    { id: 2, departments: [{ id: 10, name: "Alex PM" }], total_value: 50000, start_date: "2026-09-01", completion_date: "2026-10-01" },
    { id: 3, departments: [{ id: 20, name: "Sam PM" }], total_value: 20000, start_date: "2026-06-15", completion_date: "2026-06-20" },
  ];

  it("groups by PM and sums count/value", () => {
    const rows = aggregateWorkload(activeProjects, newTimeline);
    const alex = rows.find((r) => r.pm_id === "10");
    expect(alex.active_project_count).toBe(2);
    expect(alex.total_value).toBe(150000);
  });

  it("sums overlap days across a PM's projects, not just the max", () => {
    const rows = aggregateWorkload(activeProjects, newTimeline);
    const alex = rows.find((r) => r.pm_id === "10");
    // project 1 overlaps Jun 1 - Jul 1 = 30 days; project 2 doesn't overlap at all
    expect(alex.overlap_days).toBe(30);
  });

  it("seeds PMs from the directory even with zero current load", () => {
    const rows = aggregateWorkload([], newTimeline, [{ id: "99", name: "Idle PM" }]);
    expect(rows).toEqual([{ pm_id: "99", pm_name: "Idle PM", active_project_count: 0, total_value: 0, overlap_days: 0, timeline: [] }]);
  });
});

describe("applyAffinity", () => {
  const candidates = [
    { pm_id: "10", pm_name: "Alex" },
    { pm_id: "20", pm_name: "Sam" },
  ];
  const affinityRows = [
    { preferred_pm: "10", region: "ON", client: null, job_type: null, weight: 2, note: "handles ON well" },
    { preferred_pm: "20", region: "BC", client: null, job_type: null, weight: 5, note: "handles BC" },
  ];

  it("only applies a row when its scoped fields match the new project", () => {
    const result = applyAffinity(candidates, affinityRows, { region: "ON", client: null, jobType: null });
    expect(result.find((c) => c.pm_id === "10").affinity_weight).toBe(2);
    expect(result.find((c) => c.pm_id === "20").affinity_weight).toBe(0);
  });
});

describe("sortForDisplay", () => {
  it("ranks higher affinity and lower workload first, without mutating the input", () => {
    const candidates = [
      { pm_id: "busy", active_project_count: 5, overlap_days: 60, affinity_weight: 0 },
      { pm_id: "preferred", active_project_count: 2, overlap_days: 10, affinity_weight: 3 },
    ];
    const sorted = sortForDisplay(candidates);
    expect(sorted[0].pm_id).toBe("preferred");
    expect(candidates[0].pm_id).toBe("busy"); // original order untouched
  });
});
