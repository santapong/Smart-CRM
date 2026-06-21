import { EVENTS } from "@/lib/events";
import type { WorkflowAction } from "@/lib/workflows/types";

/**
 * Ready-made workflow templates (M9). A recipe is a named blueprint that
 * `cloneRecipe` (src/server/actions/workflows.ts) turns into a real Workflow for
 * the active org. Keep these conservative: actions must be env-tolerant (e.g.
 * send_email records-and-skips with no provider) so a cloned recipe is safe to
 * enable immediately.
 */
export type Recipe = {
  key: string;
  name: string;
  description: string;
  triggerEvent: string;
  conditions: unknown | null;
  definition: WorkflowAction[];
};

export const RECIPES: Recipe[] = [
  {
    key: "deal_won_onboarding",
    name: "Deal won → onboarding task + email",
    description:
      "When a deal is marked Won, create an onboarding task and send a thank-you email to the contact.",
    triggerEvent: EVENTS.DEAL_STATUS_CHANGED,
    // Only fire when the new status is WON.
    conditions: { "==": [{ var: "event.toStatus" }, "WON"] },
    definition: [
      {
        type: "create_task",
        title: "Kick off onboarding",
        body: "Deal won — schedule the onboarding call and send the welcome kit.",
        dueInDays: 2,
      },
      {
        type: "send_email",
        subject: "Welcome aboard!",
        body: "<p>Thanks for choosing us — we're excited to get you started.</p>",
      },
    ],
  },
  {
    key: "new_lead_assign_task",
    name: "New lead → follow-up task",
    description: "When a lead is created, create a follow-up task so it gets worked promptly.",
    triggerEvent: EVENTS.LEAD_CREATED,
    conditions: null,
    definition: [
      {
        type: "create_task",
        title: "Follow up with new lead",
        body: "A new lead came in — reach out within 24 hours.",
        dueInDays: 1,
      },
    ],
  },
  {
    key: "contact_created_welcome",
    name: "Contact created → welcome email",
    description: "Send a welcome email whenever a new contact is added.",
    triggerEvent: EVENTS.CONTACT_CREATED,
    conditions: null,
    definition: [
      {
        type: "send_email",
        subject: "Nice to meet you",
        body: "<p>Welcome! We're glad to have you in our network.</p>",
      },
    ],
  },
  {
    key: "deal_negotiation_notify",
    name: "Deal entered Negotiation → notify",
    description:
      "When a deal moves to a stage named Negotiation, create a heads-up task for the owner.",
    triggerEvent: EVENTS.DEAL_STAGE_CHANGED,
    conditions: null,
    definition: [
      {
        type: "create_task",
        title: "Deal in negotiation — review terms",
        body: "A deal advanced. Review pricing and next steps.",
        dueInDays: 1,
      },
    ],
  },
  {
    key: "lead_converted_thanks",
    name: "Lead converted → thank-you email",
    description: "Email the contact when their lead converts into a deal.",
    triggerEvent: EVENTS.LEAD_CONVERTED,
    conditions: null,
    definition: [
      {
        type: "send_email",
        subject: "Let's get started",
        body: "<p>Great news — we're moving forward together. More soon!</p>",
      },
    ],
  },
  {
    key: "deal_created_tag",
    name: "Deal created → tag the contact",
    description: "Tag the deal's contact as 'Active deal' when a new deal is created.",
    triggerEvent: EVENTS.DEAL_CREATED,
    conditions: null,
    definition: [{ type: "add_tag", tag: "Active deal" }],
  },
];

export function getRecipe(key: string): Recipe | undefined {
  return RECIPES.find((r) => r.key === key);
}
