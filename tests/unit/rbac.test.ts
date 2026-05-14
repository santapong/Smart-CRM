import { describe, it, expect } from "vitest";
import { hasRole, requireRole, ForbiddenError } from "@/lib/rbac";

describe("rbac", () => {
  it("OWNER satisfies any role", () => {
    expect(hasRole("OWNER", "MEMBER")).toBe(true);
    expect(hasRole("OWNER", "ADMIN")).toBe(true);
    expect(hasRole("OWNER", "OWNER")).toBe(true);
  });
  it("MEMBER does not satisfy ADMIN", () => {
    expect(hasRole("MEMBER", "ADMIN")).toBe(false);
    expect(hasRole("MEMBER", "MEMBER")).toBe(true);
  });
  it("null/undefined fails", () => {
    expect(hasRole(null, "MEMBER")).toBe(false);
    expect(hasRole(undefined, "MEMBER")).toBe(false);
  });
  it("requireRole throws ForbiddenError when below required", () => {
    expect(() => requireRole("MEMBER", "ADMIN")).toThrow(ForbiddenError);
  });
  it("requireRole passes when at or above required", () => {
    expect(() => requireRole("ADMIN", "ADMIN")).not.toThrow();
    expect(() => requireRole("OWNER", "ADMIN")).not.toThrow();
  });
});
