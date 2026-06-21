/**
 * Rule-based lead scoring (M13a). A score is the sum of `points` for every
 * ScoringRule whose predicate matches the record. Field lookup is flat on the
 * record but also reaches into the JSONB `customFields` map (either by a
 * "customFields.key" path or, as a fallback, by a bare key that isn't a column).
 *
 * Kept mostly pure: `matchesRule` and `scoreWithRules` are side-effect free and
 * unit-testable; `computeScore` just loads the org's rules and delegates.
 */
import { db } from "@/lib/db";
import type { ScoringRule } from "@prisma/client";

export const SCORING_OPS = ["eq", "neq", "contains", "gt", "lt", "exists"] as const;
export type ScoringOp = (typeof SCORING_OPS)[number];

export function isScoringOp(v: string): v is ScoringOp {
  return (SCORING_OPS as readonly string[]).includes(v);
}

type Record_ = Record<string, unknown> & { customFields?: unknown };

/** Resolve a rule's `field` against a record, including customFields.* paths. */
function resolveField(record: Record_, field: string): unknown {
  if (field.startsWith("customFields.")) {
    const key = field.slice("customFields.".length);
    const cf = record.customFields;
    return cf && typeof cf === "object" ? (cf as Record<string, unknown>)[key] : undefined;
  }
  if (field in record) return record[field];
  // Fallback: a bare key may live in customFields.
  const cf = record.customFields;
  if (cf && typeof cf === "object" && key_in(cf, field)) {
    return (cf as Record<string, unknown>)[field];
  }
  return undefined;
}

function key_in(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  // Prisma Decimal etc. expose toString.
  if (v != null && typeof (v as { toString?: unknown }).toString === "function") {
    const n = Number(String(v));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function present(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.length > 0;
  return true;
}

/** Whether a single rule matches the record. Pure. */
export function matchesRule(
  rule: Pick<ScoringRule, "field" | "op" | "value">,
  record: Record_,
): boolean {
  const actual = resolveField(record, rule.field);
  const op = rule.op as ScoringOp;
  switch (op) {
    case "exists":
      return present(actual);
    case "eq":
      return present(actual) && String(actual) === String(rule.value ?? "");
    case "neq":
      // A missing value counts as "not equal" to a concrete operand.
      return String(actual ?? "") !== String(rule.value ?? "");
    case "contains":
      return (
        present(actual) &&
        String(actual).toLowerCase().includes(String(rule.value ?? "").toLowerCase())
      );
    case "gt": {
      const a = toNumber(actual);
      const b = toNumber(rule.value);
      return a !== null && b !== null && a > b;
    }
    case "lt": {
      const a = toNumber(actual);
      const b = toNumber(rule.value);
      return a !== null && b !== null && a < b;
    }
    default:
      return false;
  }
}

/** Sum the points of every matching rule. Pure. */
export function scoreWithRules(
  rules: Pick<ScoringRule, "field" | "op" | "value" | "points">[],
  record: Record_,
): number {
  let total = 0;
  for (const rule of rules) if (matchesRule(rule, record)) total += rule.points;
  return total;
}

/** Load an org's rules for an entity and compute a record's score. */
export async function computeScore(
  orgId: string,
  entity: string,
  record: Record_,
): Promise<number> {
  const rules = await db.scoringRule.findMany({ where: { orgId, entity } });
  return scoreWithRules(rules, record);
}

/**
 * Recompute and persist the score for every lead in an org. Returns the count
 * updated. Called after scoring rules change.
 */
export async function recomputeAllLeadScores(orgId: string): Promise<number> {
  const rules = await db.scoringRule.findMany({ where: { orgId, entity: "lead" } });
  const leads = await db.lead.findMany({ where: { orgId } });
  let updated = 0;
  for (const lead of leads) {
    const score = scoreWithRules(rules, lead as unknown as Record_);
    if (score !== lead.score) {
      await db.lead.update({ where: { id: lead.id }, data: { score } });
      updated += 1;
    }
  }
  return updated;
}
