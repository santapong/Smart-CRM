import type { Contact, MessageChannel } from "@prisma/client";
import { db } from "@/lib/db";
import { emailDriver } from "./email";
import { telegramDriver } from "./telegram";
import { lineDriver } from "./line";
import { renderTemplate } from "./render";
import type { ChannelDriver, DispatchInput } from "./types";

const drivers: Record<MessageChannel, ChannelDriver> = {
  EMAIL: emailDriver,
  TELEGRAM: telegramDriver,
  LINE: lineDriver,
};

export function getDriver(channel: MessageChannel): ChannelDriver {
  return drivers[channel];
}

export function resolveRecipient(contact: Contact, channel: MessageChannel): string | null {
  switch (channel) {
    case "EMAIL":
      return contact.email;
    case "TELEGRAM":
      return contact.telegramChatId;
    case "LINE":
      return contact.lineUserId;
  }
}

function isOptedIn(contact: Contact, channel: MessageChannel): boolean {
  switch (channel) {
    case "EMAIL":
      return contact.emailOptIn;
    case "TELEGRAM":
      return contact.telegramOptIn;
    case "LINE":
      return contact.lineOptIn;
  }
}

export type DispatchResult =
  | { ok: true; messageLogId: string; providerMessageId?: string }
  | { ok: false; messageLogId?: string; error: string };

export async function dispatchMessage(
  orgId: string,
  input: DispatchInput,
): Promise<DispatchResult> {
  const contact = await db.contact.findFirst({ where: { id: input.contactId, orgId } });
  if (!contact) return { ok: false, error: "Contact not found" };

  if (!isOptedIn(contact, input.channel)) {
    return { ok: false, error: `Contact has opted out of ${input.channel.toLowerCase()}` };
  }

  const to = resolveRecipient(contact, input.channel);
  if (!to) {
    return { ok: false, error: `Contact has no ${input.channel.toLowerCase()} handle` };
  }

  const driver = getDriver(input.channel);
  if (!driver.isConfigured()) {
    return { ok: false, error: `${input.channel} channel is not configured on this deployment` };
  }

  let subject = input.subject;
  let body = input.body;
  const templateKey = input.templateKey;

  if (templateKey) {
    const template = await db.messageTemplate.findUnique({
      where: { orgId_channel_key: { orgId, channel: input.channel, key: templateKey } },
    });
    if (!template) return { ok: false, error: `Template "${templateKey}" not found for ${input.channel}` };
    subject = template.subject ?? undefined;
    body = template.body;
  }

  const vars = {
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email ?? "",
    ...input.variables,
  };
  const renderedSubject = subject ? renderTemplate(subject, vars) : undefined;
  const renderedBody = renderTemplate(body, vars);

  // All three drivers here are synchronous request/response — no async queue
  // sits between us and the provider — so we collapse the audit row to a
  // single insert after we know the outcome. If we add an async driver later,
  // bring back the QUEUED→SENT two-step.
  const result = await driver.send({ to, subject: renderedSubject, body: renderedBody });

  const log = await db.messageLog.create({
    data: {
      orgId,
      contactId: contact.id,
      channel: input.channel,
      direction: "OUTBOUND",
      status: result.ok ? "SENT" : "FAILED",
      subject: renderedSubject,
      body: renderedBody,
      toAddress: to,
      templateKey: templateKey ?? null,
      providerMessageId: result.ok ? result.providerMessageId ?? null : null,
      error: result.ok ? null : result.error,
      sentAt: result.ok ? new Date() : null,
    },
  });

  if (result.ok) {
    return { ok: true, messageLogId: log.id, providerMessageId: result.providerMessageId };
  }
  return { ok: false, messageLogId: log.id, error: result.error };
}
