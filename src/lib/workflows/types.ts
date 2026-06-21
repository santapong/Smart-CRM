/**
 * Shared workflow types (M9). Kept dependency-free so both the engine and the
 * server actions / UI can import them.
 */

export const ACTION_TYPES = [
  "update_field",
  "create_task",
  "send_email",
  "add_tag",
  "webhook",
  "delay",
  "branch",
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * A single action step. The `type` discriminates the params. We keep it loose
 * (extra keys allowed) so the JSON `definition` round-trips through Prisma Json
 * without fighting the type system; the engine reads only the keys it needs.
 */
export type WorkflowAction = {
  type: ActionType;
  // update_field
  field?: string;
  customField?: string;
  value?: unknown;
  // create_task
  title?: string;
  body?: string;
  dueInDays?: number;
  // send_email
  subject?: string;
  // add_tag
  tag?: string;
  // webhook
  url?: string;
  // delay
  seconds?: number;
  // branch
  condition?: unknown;
  then?: WorkflowAction[];
  else?: WorkflowAction[];
};

/** The record kinds a trigger can resolve to. */
export type RecordKind = "deal" | "contact" | "lead" | null;

/**
 * Context passed to condition evaluation and action execution. `event` is the
 * outbox payload merged with the event name; `record` is the loaded
 * deal/contact/lead the event refers to (or null when none applies).
 */
export type WorkflowContext = {
  orgId: string;
  event: Record<string, unknown> & { name: string };
  recordKind: RecordKind;
  recordId: string | null;
  record: Record<string, unknown> | null;
};

export type StepResult = {
  idx: number;
  type: string;
  status: "done" | "failed" | "skipped";
  output: unknown;
};
