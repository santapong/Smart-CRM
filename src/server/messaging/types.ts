import type { MessageChannel } from "@prisma/client";

export type SendInput = {
  to: string;
  subject?: string;
  body: string;
};

export type SendResult =
  | { ok: true; providerMessageId?: string }
  | { ok: false; error: string };

export interface ChannelDriver {
  channel: MessageChannel;
  isConfigured(): boolean;
  send(input: SendInput): Promise<SendResult>;
}

export type DispatchInput = {
  contactId: string;
  channel: MessageChannel;
  subject?: string;
  body: string;
  templateKey?: string;
  variables?: Record<string, string>;
};
