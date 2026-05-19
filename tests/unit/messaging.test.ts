import { describe, it, expect, vi } from "vitest";
import { renderTemplate } from "@/server/messaging/render";

describe("renderTemplate", () => {
  it("substitutes simple variables", () => {
    const out = renderTemplate("Hello {{firstName}} {{lastName}}!", {
      firstName: "Alice",
      lastName: "Anderson",
    });
    expect(out).toBe("Hello Alice Anderson!");
  });

  it("tolerates surrounding whitespace and missing keys", () => {
    const out = renderTemplate("{{ greeting }}, {{missing}}.", { greeting: "Hi" });
    expect(out).toBe("Hi, .");
  });

  it("returns the source unchanged when there are no placeholders", () => {
    expect(renderTemplate("Plain text.", {})).toBe("Plain text.");
  });
});

// Channel-driver dispatcher tests. We mock the underlying SDK clients so this
// stays a pure unit test — no network, no real Resend / Telegram / LINE calls.
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

vi.mock("@/server/messaging/email", () => ({
  emailDriver: {
    channel: "EMAIL",
    isConfigured: () => true,
    send: vi.fn(async () => ({ ok: true, providerMessageId: "email-1" })),
  },
}));
vi.mock("@/server/messaging/telegram", () => ({
  telegramDriver: {
    channel: "TELEGRAM",
    isConfigured: () => true,
    send: vi.fn(async () => ({ ok: true, providerMessageId: "tg-1" })),
  },
  getTelegramBot: () => null,
}));
vi.mock("@/server/messaging/line", () => ({
  lineDriver: {
    channel: "LINE",
    isConfigured: () => true,
    send: vi.fn(async () => ({ ok: true, providerMessageId: "line-1" })),
  },
  getLineClient: () => null,
}));

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { dispatchMessage } from "@/server/messaging/dispatcher";
import { emailDriver } from "@/server/messaging/email";
import { telegramDriver } from "@/server/messaging/telegram";

const db = new PrismaClient();

describe("dispatchMessage", () => {
  it("routes EMAIL through the email driver, logs SENT, and renders templates", async () => {
    const ts = Date.now();
    const pw = await bcrypt.hash("pw", 4);
    const user = await db.user.create({ data: { email: `disp${ts}@t.io`, name: "D", passwordHash: pw } });
    const org = await db.organization.create({
      data: { name: `Disp-${ts}`, slug: `disp-${ts}`, memberships: { create: { userId: user.id, role: "OWNER" } } },
    });
    const contact = await db.contact.create({
      data: { orgId: org.id, firstName: "Alice", lastName: "Anderson", email: "alice@example.com" },
    });
    await db.messageTemplate.create({
      data: {
        orgId: org.id,
        channel: "EMAIL",
        key: "welcome",
        subject: "Welcome {{firstName}}",
        body: "Hi {{firstName}} {{lastName}}, thanks for joining.",
      },
    });

    try {
      const res = await dispatchMessage(org.id, {
        contactId: contact.id,
        channel: "EMAIL",
        body: "(overridden by template)",
        templateKey: "welcome",
      });
      expect(res.ok).toBe(true);

      expect(emailDriver.send).toHaveBeenCalledWith({
        to: "alice@example.com",
        subject: "Welcome Alice",
        body: "Hi Alice Anderson, thanks for joining.",
      });

      const log = await db.messageLog.findFirstOrThrow({ where: { orgId: org.id, contactId: contact.id } });
      expect(log.status).toBe("SENT");
      expect(log.direction).toBe("OUTBOUND");
      expect(log.providerMessageId).toBe("email-1");
      expect(log.templateKey).toBe("welcome");
    } finally {
      await db.messageLog.deleteMany({ where: { orgId: org.id } });
      await db.messageTemplate.deleteMany({ where: { orgId: org.id } });
      await db.contact.deleteMany({ where: { orgId: org.id } });
      await db.membership.deleteMany({ where: { orgId: org.id } });
      await db.organization.delete({ where: { id: org.id } });
      await db.user.delete({ where: { id: user.id } });
    }
  });

  it("refuses to send when the contact has no handle for the requested channel", async () => {
    const ts = Date.now();
    const pw = await bcrypt.hash("pw", 4);
    const user = await db.user.create({ data: { email: `nochan${ts}@t.io`, name: "N", passwordHash: pw } });
    const org = await db.organization.create({
      data: { name: `NoChan-${ts}`, slug: `nochan-${ts}`, memberships: { create: { userId: user.id, role: "OWNER" } } },
    });
    const contact = await db.contact.create({
      data: { orgId: org.id, firstName: "Bob", lastName: "Brown", email: "bob@example.com" },
    });

    try {
      const res = await dispatchMessage(org.id, {
        contactId: contact.id,
        channel: "TELEGRAM",
        body: "Hello",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/telegram handle/i);
      expect(telegramDriver.send).not.toHaveBeenCalled();
    } finally {
      await db.messageLog.deleteMany({ where: { orgId: org.id } });
      await db.contact.deleteMany({ where: { orgId: org.id } });
      await db.membership.deleteMany({ where: { orgId: org.id } });
      await db.organization.delete({ where: { id: org.id } });
      await db.user.delete({ where: { id: user.id } });
    }
  });

  it("respects per-channel opt-out", async () => {
    const ts = Date.now();
    const pw = await bcrypt.hash("pw", 4);
    const user = await db.user.create({ data: { email: `opt${ts}@t.io`, name: "O", passwordHash: pw } });
    const org = await db.organization.create({
      data: { name: `Opt-${ts}`, slug: `opt-${ts}`, memberships: { create: { userId: user.id, role: "OWNER" } } },
    });
    const contact = await db.contact.create({
      data: {
        orgId: org.id,
        firstName: "Carol",
        lastName: "Clark",
        email: "carol@example.com",
        emailOptIn: false,
      },
    });

    try {
      const res = await dispatchMessage(org.id, {
        contactId: contact.id,
        channel: "EMAIL",
        body: "Hi",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/opted out/i);
    } finally {
      await db.messageLog.deleteMany({ where: { orgId: org.id } });
      await db.contact.deleteMany({ where: { orgId: org.id } });
      await db.membership.deleteMany({ where: { orgId: org.id } });
      await db.organization.delete({ where: { id: org.id } });
      await db.user.delete({ where: { id: user.id } });
    }
  });
});
