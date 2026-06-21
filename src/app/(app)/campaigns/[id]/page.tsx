import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { hasRole } from "@/lib/rbac";
import { campaignStats, parseAudience } from "@/lib/campaigns";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SendCampaignButton } from "./send-campaign-button";

export const dynamic = "force-dynamic";

function audienceLabel(a: ReturnType<typeof parseAudience>): string {
  if (a.type === "tag") return "Contacts with a tag";
  if (a.type === "company") return "Contacts at a company";
  return "All contacts with an email";
}

export default async function CampaignDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId, role } = await requireOrg();
  if (!hasRole(role, "ADMIN")) redirect("/dashboard");

  const campaign = await db.campaign.findFirst({ where: { id, orgId } });
  if (!campaign) notFound();

  const [stats, recipients] = await Promise.all([
    campaignStats(orgId, id),
    db.campaignRecipient.findMany({ where: { orgId, campaignId: id }, orderBy: { email: "asc" }, take: 500 }),
  ]);

  const cards: { label: string; value: number }[] = [
    { label: "Recipients", value: stats.total },
    { label: "Sent", value: stats.sent },
    { label: "Skipped", value: stats.skipped },
    { label: "Failed", value: stats.failed },
    { label: "Opens", value: stats.opens },
    { label: "Clicks", value: stats.clicks },
  ];

  return (
    <>
      <PageHeader
        title={campaign.name}
        description={`${campaign.subject} · ${audienceLabel(parseAudience(campaign.audience))}`}
      >
        <Badge variant={campaign.status === "SENT" ? "default" : "outline"}>{campaign.status}</Badge>
        {campaign.status === "DRAFT" && <SendCampaignButton id={campaign.id} />}
      </PageHeader>
      <div className="space-y-6 p-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {cards.map((c) => (
            <div key={c.label} className="rounded-lg border bg-card p-4">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">{c.label}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{c.value}</p>
            </div>
          ))}
        </div>

        <div className="rounded-lg border bg-card">
          <div className="border-b px-4 py-3 text-sm font-semibold">Recipients</div>
          {recipients.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No recipients yet. Sending the campaign resolves its audience.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recipients.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.email}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{r.status}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </>
  );
}
