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
import { RolesSection } from "./roles-section";
import { TeamsSection } from "./teams-section";
import { SSOSection } from "./sso-section";
import { UsageSection } from "./usage-section";
import { ssoConfigured } from "@/lib/sso";
import { getUsage } from "@/lib/usage";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { orgId, role } = await requireOrg();
  if (!hasRole(role, "ADMIN")) redirect("/dashboard");

  const [org, members, fieldDefs, apiKeys, webhookEndpoints, scoringRules, customRoles, teams, ssoConnections, usage] =
    await Promise.all([
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
    db.customRole.findMany({ where: { orgId }, orderBy: { name: "asc" } }),
    db.team.findMany({
      where: { orgId },
      orderBy: { name: "asc" },
      include: { members: { orderBy: { createdAt: "asc" } } },
    }),
    db.sSOConnection.findMany({ where: { orgId }, orderBy: { createdAt: "desc" } }),
    getUsage(orgId),
  ]);
  if (!org) redirect("/login");

  // Resolve team member display info from the org's membership list (TeamMember
  // has no User relation by design — keeps the model lean).
  const usersById = new Map(members.map((m) => [m.userId, m.user]));
  const teamRows = teams.map((t) => ({
    id: t.id,
    name: t.name,
    members: t.members
      .map((tm) => {
        const u = usersById.get(tm.userId);
        return u ? { userId: u.id, name: u.name, email: u.email } : null;
      })
      .filter((m): m is { userId: string; name: string | null; email: string } => m !== null),
  }));
  const orgMembers = members.map((m) => ({ userId: m.userId, name: m.user.name, email: m.user.email }));

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
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Usage &amp; billing</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Your current plan usage against its limits. Bars turn amber near a limit and red once it&apos;s reached.
          </p>
          <UsageSection usage={usage} />
        </section>
        <section className="rounded-lg border bg-card p-6">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Roles &amp; permissions</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Define custom roles that add permissions on top of a member&apos;s base role, then assign them.
          </p>
          <RolesSection
            roles={customRoles.map((r) => ({ id: r.id, name: r.name, permissions: r.permissions }))}
            members={members.map((m) => ({
              id: m.id,
              name: m.user.name,
              email: m.user.email,
              role: m.role,
              customRoleId: m.customRoleId,
            }))}
          />
        </section>
        <section className="rounded-lg border bg-card p-6">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Teams</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Group members into teams. Powers future visibility and territory rules.
          </p>
          <TeamsSection teams={teamRows} members={orgMembers} />
        </section>
        <section className="rounded-lg border bg-card p-6 lg:col-span-2">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">SSO (SAML)</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Store your identity provider&apos;s SAML metadata for single sign-on.
          </p>
          <SSOSection
            configured={ssoConfigured()}
            connections={ssoConnections.map((c) => ({
              id: c.id,
              label: c.label,
              status: c.status,
              hasMetadata: !!c.metadataXml,
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
