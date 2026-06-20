import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { hasRole } from "@/lib/rbac";
import { selectOptions, type CustomFieldEntity, type CustomFieldType } from "@/lib/custom-fields";
import { EVENTS } from "@/lib/events";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { OrgNameForm } from "./org-name-form";
import { MembersSection } from "./members-section";
import { CustomFieldsSection } from "./custom-fields-section";
import { ApiKeysSection } from "./api-keys-section";
import { WebhooksSection } from "./webhooks-section";
import { ScoringRulesSection } from "./scoring-rules-section";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { orgId, role } = await requireOrg();
  if (!hasRole(role, "ADMIN")) redirect("/dashboard");

  const [org, members, fieldDefs, apiKeys, webhookEndpoints, scoringRules] = await Promise.all([
    db.organization.findUnique({ where: { id: orgId } }),
    db.membership.findMany({
      where: { orgId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    db.customFieldDefinition.findMany({
      where: { orgId },
      orderBy: [{ entity: "asc" }, { order: "asc" }, { createdAt: "asc" }],
    }),
    db.apiKey.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, lookupPrefix: true, scopes: true, lastUsedAt: true, createdAt: true },
    }),
    db.webhookEndpoint.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      select: { id: true, url: true, secret: true, enabledEvents: true, status: true, createdAt: true },
    }),
    db.scoringRule.findMany({
      where: { orgId, entity: "lead" },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  if (!org) redirect("/login");

  return (
    <>
      <PageHeader title="Settings" description="Manage your workspace and members." />
      <div className="grid gap-6 p-6 lg:grid-cols-2">
        <section className="rounded-lg border bg-card p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Organization</h2>
          <OrgNameForm name={org.name} />
        </section>
        <section className="rounded-lg border bg-card p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Members</h2>
          <MembersSection
            members={members.map((m) => ({
              id: m.id,
              role: m.role,
              userId: m.userId,
              email: m.user.email,
              name: m.user.name,
            }))}
          />
        </section>
        <section className="rounded-lg border bg-card p-6 lg:col-span-2">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Custom fields</h2>
          <CustomFieldsSection
            definitions={fieldDefs.map((d) => ({
              id: d.id,
              entity: d.entity as CustomFieldEntity,
              key: d.key,
              label: d.label,
              type: d.type as CustomFieldType,
              required: d.required,
              options: selectOptions(d),
            }))}
          />
        </section>
        <section className="rounded-lg border bg-card p-6 lg:col-span-2">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Lead scoring</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Rules that add points to a lead&apos;s score. Scores recompute when rules change.
          </p>
          <ScoringRulesSection
            rules={scoringRules.map((r) => ({
              id: r.id,
              field: r.field,
              op: r.op,
              value: r.value,
              points: r.points,
            }))}
          />
        </section>
        <section className="rounded-lg border bg-card p-6">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">API keys</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Authenticate the public REST API (<code>/api/v1</code>) with a Bearer key.
          </p>
          <ApiKeysSection
            keys={apiKeys.map((k) => ({
              id: k.id,
              name: k.name,
              lookupPrefix: k.lookupPrefix,
              scopes: k.scopes,
              lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
              createdAt: k.createdAt.toISOString(),
            }))}
          />
        </section>
        <section className="rounded-lg border bg-card p-6">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Webhooks</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            POST signed events to your endpoints. Verify the <code>X-SmartCRM-Signature</code> header.
          </p>
          <WebhooksSection
            availableEvents={Object.values(EVENTS)}
            endpoints={webhookEndpoints.map((w) => ({
              id: w.id,
              url: w.url,
              secret: w.secret,
              enabledEvents: w.enabledEvents,
              status: w.status,
              createdAt: w.createdAt.toISOString(),
            }))}
          />
        </section>
        <section className="rounded-lg border bg-card p-6 lg:col-span-2">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Data</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Import records from a CSV, or find and merge duplicate contacts and companies.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href="/import">Import CSV</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/settings/duplicates">Find duplicates</Link>
            </Button>
          </div>
        </section>
        <section className="rounded-lg border bg-card p-6 lg:col-span-2">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Integrations</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Connect Slack, Gmail, Calendar, and Zapier. Slack posts deal and lead alerts to a channel.
          </p>
          <Button asChild size="sm" variant="outline">
            <Link href="/settings/integrations">Manage integrations</Link>
          </Button>
        </section>
      </div>
    </>
  );
}
