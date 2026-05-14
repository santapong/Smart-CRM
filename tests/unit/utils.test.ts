import { describe, it, expect } from "vitest";
import { slugify, initials, formatCurrency, cn } from "@/lib/utils";

describe("utils", () => {
  it("slugify lowercases and replaces non-alnum", () => {
    expect(slugify("Acme Inc.")).toBe("acme-inc");
    expect(slugify("  Multi   Spaces  ")).toBe("multi-spaces");
  });
  it("initials returns up to 2 uppercase letters", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("cher")).toBe("C");
    expect(initials(null)).toBe("?");
  });
  it("formatCurrency formats USD by default", () => {
    expect(formatCurrency(1234)).toMatch(/\$1,234/);
  });
  it("cn merges classes", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
});
