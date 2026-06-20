import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Duplicate detection + record merge (M13c).
 *
 * {@link findDuplicates} groups likely-duplicate records (contacts by lowercased
 * email; companies by domain, else name). {@link mergeRecords} folds a `source`
 * record into a `target` in a single transaction — relinking all children
 * (deals, activities, tags, leads, emails / for companies: contacts, deals),
 * applying field survivorship (fill blank target fields from source), writing a
 * {@link MergeLog} snapshot, then deleting the source. {@link undoMerge}
 * best-effort restores a merge from its snapshot. Everything is org-scoped.
 */

export type MergeEntity = "contact" | "company";

export type DuplicateGroup = {
  key: string;
  records: { id: string; label: string; subtitle: string | null }[];
};

function contactLabel(c: { firstName: string; lastName: string }): string {
  return `${c.firstName} ${c.lastName}`.trim() || "(no name)";
}

/** Group records that share a natural key. Only groups of 2+ are returned. */
export async function findDuplicates(orgId: string, entity: MergeEntity): Promise<DuplicateGroup[]> {
  if (entity === "contact") {
    const contacts = await db.contact.findMany({
      where: { orgId, email: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    const byKey = new Map<string, typeof contacts>();
    for (const c of contacts) {
      const key = c.email!.toLowerCase();
      const arr = byKey.get(key) ?? [];
      arr.push(c);
      byKey.set(key, arr);
    }
    return [...byKey.entries()]
      .filter(([, arr]) => arr.length > 1)
      .map(([key, arr]) => ({
        key,
        records: arr.map((c) => ({ id: c.id, label: contactLabel(c), subtitle: c.email })),
      }));
  }

  const companies = await db.company.findMany({
    where: { orgId },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, domain: true },
  });
  const byKey = new Map<string, { rows: typeof companies; byDomain: boolean }>();
  for (const c of companies) {
    const domain = c.domain?.trim();
    const key = domain ? `d:${domain.toLowerCase()}` : `n:${c.name.toLowerCase()}`;
    const entry = byKey.get(key) ?? { rows: [], byDomain: !!domain };
    entry.rows.push(c);
    byKey.set(key, entry);
  }
  return [...byKey.entries()]
    .filter(([, entry]) => entry.rows.length > 1)
    .map(([key, entry]) => ({
      key: key.slice(2),
      records: entry.rows.map((c) => ({ id: c.id, label: c.name, subtitle: c.domain })),
    }));
}

/** Fill blank target fields from the source (survivorship), excluding system cols. */
function survivorship<T extends Record<string, unknown>>(
  target: T,
  source: T,
  fields: (keyof T)[],
): Partial<T> {
  const patch: Partial<T> = {};
  for (const f of fields) {
    const t = target[f];
    const s = source[f];
    const targetBlank = t === null || t === undefined || t === "";
    const sourceHas = s !== null && s !== undefined && s !== "";
    if (targetBlank && sourceHas) patch[f] = s;
  }
  return patch;
}

export type MergeResult = {
  mergeLogId: string;
  targetId: string;
  sourceId: string;
  relinked: Record<string, number>;
};

/**
 * Merge `sourceId` into `targetId` for an org. Relinks children, applies
 * survivorship, snapshots + deletes the source. Throws if either record is
 * missing/cross-org or ids are equal.
 */
export async function mergeRecords(
  orgId: string,
  entity: MergeEntity,
  targetId: string,
  sourceId: string,
): Promise<MergeResult> {
  if (targetId === sourceId) throw new Error("Cannot merge a record into itself");

  return db.$transaction(async (tx) => {
    if (entity === "contact") {
      const [target, source] = await Promise.all([
        tx.contact.findFirst({ where: { id: targetId, orgId } }),
        tx.contact.findFirst({ where: { id: sourceId, orgId } }),
      ]);
      if (!target || !source) throw new Error("Record not found");

      // Capture the child ids we relink so undo can move back exactly these
      // (not the target's own children).
      const [dealIds, activityIds, leadIds, emailIds] = await Promise.all([
        tx.deal.findMany({ where: { contactId: sourceId, orgId }, select: { id: true } }),
        tx.activity.findMany({ where: { contactId: sourceId, orgId }, select: { id: true } }),
        tx.lead.findMany({ where: { contactId: sourceId, orgId }, select: { id: true } }),
        tx.emailMessage.findMany({ where: { contactId: sourceId, orgId }, select: { id: true } }),
      ]);
      const movedIds = {
        deals: dealIds.map((r) => r.id),
        activities: activityIds.map((r) => r.id),
        leads: leadIds.map((r) => r.id),
        emailMessages: emailIds.map((r) => r.id),
      };

      await tx.deal.updateMany({ where: { contactId: sourceId, orgId }, data: { contactId: targetId } });
      await tx.activity.updateMany({ where: { contactId: sourceId, orgId }, data: { contactId: targetId } });
      await tx.lead.updateMany({ where: { contactId: sourceId, orgId }, data: { contactId: targetId } });
      await tx.emailMessage.updateMany({ where: { contactId: sourceId, orgId }, data: { contactId: targetId } });

      // ContactTag has a composite PK (contactId,tagId) — move only tags the
      // target doesn't already have, then drop any remaining source tags.
      const sourceTags = await tx.contactTag.findMany({ where: { contactId: sourceId } });
      const targetTags = await tx.contactTag.findMany({ where: { contactId: targetId } });
      const targetTagIds = new Set(targetTags.map((t) => t.tagId));
      const movedTagIds: string[] = [];
      for (const st of sourceTags) {
        if (!targetTagIds.has(st.tagId)) {
          await tx.contactTag.create({ data: { contactId: targetId, tagId: st.tagId } });
          movedTagIds.push(st.tagId);
        }
      }
      await tx.contactTag.deleteMany({ where: { contactId: sourceId } });

      const relinked: Record<string, number> = {
        deals: movedIds.deals.length,
        activities: movedIds.activities.length,
        leads: movedIds.leads.length,
        emailMessages: movedIds.emailMessages.length,
        tags: movedTagIds.length,
      };

      const patch = survivorship(target, source, ["companyId", "email", "phone", "title", "notes", "firstName", "lastName"]);
      if (Object.keys(patch).length > 0) {
        await tx.contact.update({ where: { id: targetId }, data: patch as Prisma.ContactUpdateInput });
      }

      const log = await tx.mergeLog.create({
        data: {
          orgId,
          entity,
          targetId,
          sourceId,
          snapshot: { source, relinked, patch, movedIds: { ...movedIds, tags: movedTagIds } } as unknown as Prisma.InputJsonValue,
        },
      });

      await tx.contact.delete({ where: { id: sourceId } });
      return { mergeLogId: log.id, targetId, sourceId, relinked };
    }

    // entity === "company"
    const [target, source] = await Promise.all([
      tx.company.findFirst({ where: { id: targetId, orgId } }),
      tx.company.findFirst({ where: { id: sourceId, orgId } }),
    ]);
    if (!target || !source) throw new Error("Record not found");

    const [contactRows, dealRows] = await Promise.all([
      tx.contact.findMany({ where: { companyId: sourceId, orgId }, select: { id: true } }),
      tx.deal.findMany({ where: { companyId: sourceId, orgId }, select: { id: true } }),
    ]);
    const movedIds = { contacts: contactRows.map((r) => r.id), deals: dealRows.map((r) => r.id) };

    await tx.contact.updateMany({ where: { companyId: sourceId, orgId }, data: { companyId: targetId } });
    await tx.deal.updateMany({ where: { companyId: sourceId, orgId }, data: { companyId: targetId } });

    const relinked: Record<string, number> = { contacts: movedIds.contacts.length, deals: movedIds.deals.length };

    const patch = survivorship(target, source, ["domain", "industry", "size", "notes", "name"]);
    if (Object.keys(patch).length > 0) {
      await tx.company.update({ where: { id: targetId }, data: patch as Prisma.CompanyUpdateInput });
    }

    const log = await tx.mergeLog.create({
      data: {
        orgId,
        entity,
        targetId,
        sourceId,
        snapshot: { source, relinked, patch, movedIds } as unknown as Prisma.InputJsonValue,
      },
    });

    await tx.company.delete({ where: { id: sourceId } });
    return { mergeLogId: log.id, targetId, sourceId, relinked };
  });
}

type Snapshot = {
  source: Record<string, unknown>;
  relinked?: Record<string, number>;
  patch?: Record<string, unknown>;
  movedIds?: Record<string, string[]>;
};

/**
 * Best-effort undo of a merge: recreate the source record from the snapshot and
 * move its children back from the target. Does not revert survivorship patches
 * applied to the target (target may have changed since). Org-scoped.
 */
export async function undoMerge(orgId: string, mergeLogId: string): Promise<{ sourceId: string }> {
  const log = await db.mergeLog.findFirst({ where: { id: mergeLogId, orgId } });
  if (!log) throw new Error("Merge log not found");
  const snap = log.snapshot as unknown as Snapshot;
  const source = snap.source;
  if (!source || typeof source !== "object") throw new Error("Snapshot missing source");

  const entity = log.entity as MergeEntity;
  const sourceId = log.sourceId;
  const targetId = log.targetId;
  const moved = snap.movedIds ?? {};

  await db.$transaction(async (tx) => {
    if (entity === "contact") {
      const s = source as {
        firstName: string;
        lastName: string;
        email: string | null;
        phone: string | null;
        title: string | null;
        notes: string | null;
        companyId: string | null;
        customFields: unknown;
      };
      await tx.contact.create({
        data: {
          id: sourceId,
          orgId,
          firstName: s.firstName,
          lastName: s.lastName,
          email: s.email,
          phone: s.phone,
          title: s.title,
          notes: s.notes,
          companyId: s.companyId,
          customFields: (s.customFields ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
      // Move back exactly the children we relinked (by id) — the target's own
      // children are left untouched.
      if (moved.deals?.length) await tx.deal.updateMany({ where: { id: { in: moved.deals }, orgId }, data: { contactId: sourceId } });
      if (moved.activities?.length) await tx.activity.updateMany({ where: { id: { in: moved.activities }, orgId }, data: { contactId: sourceId } });
      if (moved.leads?.length) await tx.lead.updateMany({ where: { id: { in: moved.leads }, orgId }, data: { contactId: sourceId } });
      if (moved.emailMessages?.length) await tx.emailMessage.updateMany({ where: { id: { in: moved.emailMessages }, orgId }, data: { contactId: sourceId } });
      for (const tagId of moved.tags ?? []) {
        await tx.contactTag.deleteMany({ where: { contactId: targetId, tagId } });
        await tx.contactTag.create({ data: { contactId: sourceId, tagId } });
      }
    } else {
      const s = source as {
        name: string;
        domain: string | null;
        industry: string | null;
        size: string | null;
        notes: string | null;
        customFields: unknown;
      };
      await tx.company.create({
        data: {
          id: sourceId,
          orgId,
          name: s.name,
          domain: s.domain,
          industry: s.industry,
          size: s.size,
          notes: s.notes,
          customFields: (s.customFields ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
      if (moved.contacts?.length) await tx.contact.updateMany({ where: { id: { in: moved.contacts }, orgId }, data: { companyId: sourceId } });
      if (moved.deals?.length) await tx.deal.updateMany({ where: { id: { in: moved.deals }, orgId }, data: { companyId: sourceId } });
    }

    await tx.mergeLog.delete({ where: { id: mergeLogId } });
  });

  return { sourceId };
}
