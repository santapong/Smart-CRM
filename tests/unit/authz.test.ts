import { describe, it, expect } from "vitest";
import { defineAbilityFor, can, authorize } from "@/lib/authz";
import { ForbiddenError } from "@/lib/rbac";

describe("authz (CASL choke-point, M1)", () => {
  it("MEMBER cannot manage org settings or members", () => {
    const ability = defineAbilityFor({ role: "MEMBER" });
    expect(can(ability, "manage", "org")).toBe(false);
    expect(can(ability, "manage", "member")).toBe(false);
    expect(() => authorize(ability, "manage", "org")).toThrow(ForbiddenError);
  });

  it("ADMIN can manage org settings and members", () => {
    const ability = defineAbilityFor({ role: "ADMIN" });
    expect(can(ability, "manage", "org")).toBe(true);
    expect(can(ability, "manage", "member")).toBe(true);
    expect(() => authorize(ability, "manage", "org")).not.toThrow();
  });

  it("OWNER can manage org settings and members", () => {
    const ability = defineAbilityFor({ role: "OWNER" });
    expect(can(ability, "manage", "org")).toBe(true);
    expect(can(ability, "manage", "member")).toBe(true);
    expect(() => authorize(ability, "manage", "member")).not.toThrow();
  });

  it("MEMBER can manage CRM records", () => {
    const ability = defineAbilityFor({ role: "MEMBER" });
    expect(can(ability, "manage", "contact")).toBe(true);
    expect(can(ability, "manage", "company")).toBe(true);
    expect(can(ability, "manage", "deal")).toBe(true);
    expect(can(ability, "manage", "activity")).toBe(true);
    expect(can(ability, "manage", "pipeline")).toBe(true);
    expect(() => authorize(ability, "update", "contact")).not.toThrow();
  });
});
