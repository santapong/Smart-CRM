import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

let active: { userId: string; orgId: string; role: "OWNER" | "ADMIN" | "MEMBER" } | null = null;
vi.mock("@/lib/tenant", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tenant")>("@/lib/tenant");
  return {
    ...actual,
    requireOrg: async () => {
      if (!active) throw new Error("No active org for test");
      return active;
    },
  };
});

import {
  createSequence,
  updateSequence,
  deleteSequence,
  addStep,
  updateStep,
  removeStep,
  reorderSteps,
} from "@/server/actions/sequences";
import { enroll, stopEnrollment } from "@/server/actions/enrollments";
import { processDueEnrollments } from "@/lib/sequences/runner";

let orgA = "",
  orgB = "",
  userA = "",
  userB = "",
  contactA = "",
  contactNoEmailA = "",
  contactB = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const ua = await db.user.create({ data: { email: `sqa${ts}@t.io`, name: "A", passwordHash: pw } });
  const ub = await db.user.create({ data: { email: `sqb${ts}@t.io`, name: "B", passwordHash: pw } });
  const oa = await db.organization.create({
    data: { name: `SqOrgA-${ts}`, slug: `sq-orga-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({
    data: { name: `SqOrgB-${ts}`, slug: `sq-orgb-${ts}`, memberships: { create: { userId: ub.id, role: "OWNER" } } },
  });
  orgA = oa.id;
  orgB = ob.id;
  userA = ua.id;
  userB = ub.id;
  // Free plan allows 0 sequences — lift the cap for both orgs in the suite.
  await db.entitlement.create({ data: { orgId: orgA, key: "sequences", intValue: -1 } });
  await db.entitlement.create({ data: { orgId: orgB, key: "sequences", intValue: -1 } });
  const ca = await db.contact.create({
    data: { orgId: orgA, firstName: "Cad", lastName: "Ence", email: `cad${ts}@t.io` },
  });
  const cn = await db.contact.create({ data: { orgId: orgA, firstName: "No", lastName: "Mail" } });
  const cb = await db.contact.create({
    data: { orgId: orgB, firstName: "Other", lastName: "Org", email: `other${ts}@t.io` },
  });
  contactA = ca.id;
  contactNoEmailA = cn.id;
  contactB = cb.id;
});

afterAll(async () => {
  const orgs = [orgA, orgB];
  await db.sequenceEnrollment.deleteMany({ where: { orgId: { in: orgs } } });
  await db.sequenceStep.deleteMany({ where: { sequence: { orgId: { in: orgs } } } });
  await db.sequence.deleteMany({ where: { orgId: { in: orgs } } });
  await db.activity.deleteMany({ where: { orgId: { in: orgs } } });
  await db.emailMessage.deleteMany({ where: { orgId: { in: orgs } } });
  await db.lead.deleteMany({ where: { orgId: { in: orgs } } });
  await db.contact.deleteMany({ where: { orgId: { in: orgs } } });
  await db.entitlement.deleteMany({ where: { orgId: { in: orgs } } });
  await db.subscription.deleteMany({ where: { orgId: { in: orgs } } });
  await db.membership.deleteMany({ where: { orgId: { in: orgs } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
  await db.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  await db.$disconnect();
});

const id = (r: unknown) => (r as { data: { id: string } }).data.id;

describe("sequence + step CRUD (M13b)", () => {
  it("creates a sequence, adds/updates/reorders/removes steps (ADMIN)", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const seq = await createSequence({ name: "Nurture" });
    expect(seq.ok).toBe(true);
    const seqId = id(seq);
    const row = await db.sequence.findUnique({ where: { id: seqId } });
    expect(row?.orgId).toBe(orgA);
    expect(row?.enabled).toBe(true);

    const s1 = await addStep(seqId, { type: "email", subject: "Hello", body: "Welcome" });
    const s2 = await addStep(seqId, { type: "wait", waitDays: 2 });
    const s3 = await addStep(seqId, { type: "task", subject: "Call them" });
    expect(s1.ok && s2.ok && s3.ok).toBe(true);

    let steps = await db.sequenceStep.findMany({ where: { sequenceId: seqId }, orderBy: { order: "asc" } });
    expect(steps.map((s) => s.order)).toEqual([0, 1, 2]);
    expect(steps.map((s) => s.type)).toEqual(["email", "wait", "task"]);

    // Update a step.
    const upd = await updateStep(id(s1), { subject: "Hi there" });
    expect(upd.ok).toBe(true);

    // Reorder: move the task to the front.
    const reorder = await reorderSteps(seqId, { stepIds: [id(s3), id(s1), id(s2)] });
    expect(reorder.ok).toBe(true);
    steps = await db.sequenceStep.findMany({ where: { sequenceId: seqId }, orderBy: { order: "asc" } });
    expect(steps.map((s) => s.id)).toEqual([id(s3), id(s1), id(s2)]);

    // Remove the middle step → orders re-pack to 0,1.
    const rm = await removeStep(id(s1));
    expect(rm.ok).toBe(true);
    steps = await db.sequenceStep.findMany({ where: { sequenceId: seqId }, orderBy: { order: "asc" } });
    expect(steps.map((s) => s.order)).toEqual([0, 1]);

    // Toggle enabled, then delete.
    const toggle = await updateSequence(seqId, { enabled: false });
    expect(toggle.ok).toBe(true);
    expect((await db.sequence.findUnique({ where: { id: seqId } }))?.enabled).toBe(false);
    const del = await deleteSequence(seqId);
    expect(del.ok).toBe(true);
    expect(await db.sequence.findUnique({ where: { id: seqId } })).toBeNull();
  });

  it("rejects email/task steps without a subject", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const seq = await createSequence({ name: "Validate" });
    const bad = await addStep(id(seq), { type: "email" });
    expect(bad.ok).toBe(false);
    await deleteSequence(id(seq));
  });

  it("forbids non-admins from creating sequences", async () => {
    active = { userId: userA, orgId: orgA, role: "MEMBER" };
    await expect(createSequence({ name: "Nope" })).rejects.toThrow();
  });
});

describe("enroll (M13b)", () => {
  it("creates an active enrollment at step 0, due now", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const seq = await createSequence({ name: "Enroll seq" });
    await addStep(id(seq), { type: "task", subject: "Do it" });

    active = { userId: userA, orgId: orgA, role: "MEMBER" };
    const e = await enroll({ sequenceId: id(seq), contactId: contactA });
    expect(e.ok).toBe(true);
    const row = await db.sequenceEnrollment.findUnique({ where: { id: id(e) } });
    expect(row?.status).toBe("active");
    expect(row?.currentStep).toBe(0);
    expect(row?.contactId).toBe(contactA);
    expect(row?.nextRunAt).not.toBeNull();
    expect(row!.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    // Duplicate active enrollment of the same record is rejected.
    const dup = await enroll({ sequenceId: id(seq), contactId: contactA });
    expect(dup.ok).toBe(false);

    // Stopping it allows re-enrollment.
    const stop = await stopEnrollment(id(e));
    expect(stop.ok).toBe(true);
    expect((await db.sequenceEnrollment.findUnique({ where: { id: id(e) } }))?.status).toBe("stopped");
    const again = await enroll({ sequenceId: id(seq), contactId: contactA });
    expect(again.ok).toBe(true);
  });

  it("fails when the record has no email on file", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const seq = await createSequence({ name: "No email seq" });
    await addStep(id(seq), { type: "email", subject: "Hi" });
    active = { userId: userA, orgId: orgA, role: "MEMBER" };
    const e = await enroll({ sequenceId: id(seq), contactId: contactNoEmailA });
    expect(e.ok).toBe(false);
  });

  it("enrolls a lead via its linked contact's email", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const seq = await createSequence({ name: "Lead seq" });
    await addStep(id(seq), { type: "task", subject: "Qualify" });
    const lead = await db.lead.create({ data: { orgId: orgA, title: "Hot lead", contactId: contactA } });

    active = { userId: userA, orgId: orgA, role: "MEMBER" };
    const e = await enroll({ sequenceId: id(seq), leadId: lead.id });
    expect(e.ok).toBe(true);
    expect((await db.sequenceEnrollment.findUnique({ where: { id: id(e) } }))?.leadId).toBe(lead.id);
  });
});

describe("processDueEnrollments (M13b)", () => {
  it("advances email → wait → task and completes at the end", async () => {
    // Isolate the runner from enrollments created by earlier tests so the
    // counts below reflect only this sequence.
    await db.sequenceEnrollment.updateMany({
      where: { orgId: orgA, status: "active" },
      data: { status: "stopped", nextRunAt: null },
    });
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const seq = await createSequence({ name: "Runner seq" });
    await addStep(id(seq), { type: "email", subject: "Step one", body: "Hi" });
    await addStep(id(seq), { type: "wait", waitDays: 1 });
    await addStep(id(seq), { type: "task", subject: "Step three" });

    active = { userId: userA, orgId: orgA, role: "MEMBER" };
    const e = await enroll({ sequenceId: id(seq), contactId: contactA });
    const enrollmentId = id(e);

    const emailsBefore = await db.emailMessage.count({ where: { orgId: orgA, contactId: contactA } });
    const activitiesBefore = await db.activity.count({ where: { orgId: orgA, contactId: contactA } });

    // Tick 1: email step → recorded, advance to wait, due now.
    await processDueEnrollments();
    let row = await db.sequenceEnrollment.findUnique({ where: { id: enrollmentId } });
    expect(row?.currentStep).toBe(1);
    expect(row?.status).toBe("active");
    const emailsAfter = await db.emailMessage.count({ where: { orgId: orgA, contactId: contactA } });
    expect(emailsAfter).toBe(emailsBefore + 1);

    // Tick 2: wait step → advance pointer, push nextRunAt into the future.
    await processDueEnrollments();
    row = await db.sequenceEnrollment.findUnique({ where: { id: enrollmentId } });
    expect(row?.currentStep).toBe(2);
    expect(row?.status).toBe("active");
    expect(row?.nextRunAt).not.toBeNull();
    expect(row!.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 1000);

    // Not due yet → a tick is a no-op for this enrollment.
    await processDueEnrollments();
    row = await db.sequenceEnrollment.findUnique({ where: { id: enrollmentId } });
    expect(row?.currentStep).toBe(2);

    // Make the wait elapse, then tick: task step → Activity created, completed.
    await db.sequenceEnrollment.update({ where: { id: enrollmentId }, data: { nextRunAt: new Date(Date.now() - 1000) } });
    await processDueEnrollments();
    row = await db.sequenceEnrollment.findUnique({ where: { id: enrollmentId } });
    expect(row?.status).toBe("completed");
    expect(row?.nextRunAt).toBeNull();
    const activitiesAfter = await db.activity.count({ where: { orgId: orgA, contactId: contactA } });
    expect(activitiesAfter).toBe(activitiesBefore + 1);
  });

  it("stops an enrollment cleanly when its sequence is disabled", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const seq = await createSequence({ name: "Disabled mid-run" });
    await addStep(id(seq), { type: "task", subject: "T1" });
    active = { userId: userA, orgId: orgA, role: "MEMBER" };
    const e = await enroll({ sequenceId: id(seq), contactId: contactA });
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    await updateSequence(id(seq), { enabled: false });
    await processDueEnrollments();
    const row = await db.sequenceEnrollment.findUnique({ where: { id: id(e) } });
    expect(row?.status).toBe("stopped");
  });
});

describe("cross-org isolation (M13b)", () => {
  it("cannot enroll a contact from another org", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const seq = await createSequence({ name: "Iso seq" });
    await addStep(id(seq), { type: "task", subject: "x" });
    active = { userId: userA, orgId: orgA, role: "MEMBER" };
    const e = await enroll({ sequenceId: id(seq), contactId: contactB });
    expect(e.ok).toBe(false);
  });

  it("org B (ADMIN) cannot edit or delete org A's sequence", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const seq = await createSequence({ name: "A private seq" });
    const seqId = id(seq);
    const s = await addStep(seqId, { type: "task", subject: "owned" });

    active = { userId: userB, orgId: orgB, role: "ADMIN" };
    expect((await updateSequence(seqId, { name: "hijack" })).ok).toBe(false);
    expect((await addStep(seqId, { type: "task", subject: "sneak" })).ok).toBe(false);
    expect((await updateStep(id(s), { subject: "nope" })).ok).toBe(false);
    expect((await removeStep(id(s))).ok).toBe(false);
    expect((await deleteSequence(seqId)).ok).toBe(false);

    const row = await db.sequence.findUnique({ where: { id: seqId } });
    expect(row?.orgId).toBe(orgA);
    expect(row?.name).toBe("A private seq");
  });

  it("the runner only processes the org that owns each enrollment", async () => {
    // Enrollment in org A; an org-B sequence/contact must be untouched.
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const seqA = await createSequence({ name: "A runner iso" });
    await addStep(id(seqA), { type: "task", subject: "A task" });
    active = { userId: userA, orgId: orgA, role: "MEMBER" };
    await enroll({ sequenceId: id(seqA), contactId: contactA });

    const bActivitiesBefore = await db.activity.count({ where: { orgId: orgB } });
    await processDueEnrollments();
    const bActivitiesAfter = await db.activity.count({ where: { orgId: orgB } });
    expect(bActivitiesAfter).toBe(bActivitiesBefore);
  });
});
