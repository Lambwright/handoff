import { describe, it, expect } from "vitest";
import { normalizeType, buildGateTasks, CHECKLIST_REGISTRY, ESTIMATE_PROJECT_TYPES } from "../src/checklist.js";

describe("normalizeType", () => {
  it("maps common Procore-ish labels onto the fixed set", () => {
    expect(normalizeType("T&M")).toBe("T&M");
    expect(normalizeType("Time and Material")).toBe("T&M");
    expect(normalizeType("Lump Sum Contract")).toBe("Contract");
    expect(normalizeType("Service Call")).toBe("Service Call");
    expect(normalizeType("Warranty Work")).toBe("Warranty");
    expect(normalizeType("Overhead")).toBe("Overhead");
  });

  it("returns null for empty/unknown input", () => {
    expect(normalizeType("")).toBe(null);
    expect(normalizeType(null)).toBe(null);
  });
});

describe("buildGateTasks", () => {
  it("always includes the always-on items", () => {
    for (const type of ESTIMATE_PROJECT_TYPES) {
      const tasks = buildGateTasks(type);
      const keys = tasks.map((t) => t.task_type);
      expect(keys).toContain("address");
      expect(keys).toContain("customer");
      expect(keys).toContain("scope_summary");
    }
  });

  it("includes PO number / PO document for Contract but not Warranty", () => {
    const contract = buildGateTasks("Contract").map((t) => t.task_type);
    const warranty = buildGateTasks("Warranty").map((t) => t.task_type);
    expect(contract).toContain("po_number");
    expect(contract).toContain("po_document");
    expect(warranty).not.toContain("po_number");
    expect(warranty).not.toContain("po_document");
  });

  it("defaults an unknown type to the strictest reasonable set (Contract)", () => {
    const unknown = buildGateTasks("Nonsense").map((t) => t.task_type);
    const contract = buildGateTasks("Contract").map((t) => t.task_type);
    expect(unknown).toEqual(contract);
  });

  it("carries verify_backing through only for the items that declare it", () => {
    const tasks = buildGateTasks("Contract");
    const tender = tasks.find((t) => t.task_type === "tender_correspondence");
    const address = tasks.find((t) => t.task_type === "address");
    expect(tender.verify_backing).toBe("email_communications");
    expect(address.verify_backing).toBe(null);
  });

  it("every registry item declares a types map covering all five project types", () => {
    const ALL_TYPES = ["T&M", "Contract", "Service Call", "Warranty", "Overhead"];
    for (const item of CHECKLIST_REGISTRY) {
      for (const t of ALL_TYPES) expect(item.types).toHaveProperty(t);
    }
  });
});
