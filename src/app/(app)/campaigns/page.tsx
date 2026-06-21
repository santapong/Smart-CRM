import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { hasRole } from "@/lib/rbac";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  DRAFT: "outline",
  SCHEDULED: "secondary",
  SENDING: "secondary",
  SENT: "default",
  FAILED: "outline",
};

export default async function CampaignsPage() {
  const { orgId, role } = await requireOrg();
  if (!hasRole(role, "ADMIN")) redirect("/dashboard");

  const campaigns = await db.campaign.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { recipients: true } } },
  });

  return (
    <>
      <PageHeader title="Campaigns" description="Send bulk marketing email to a contact segment.">
        <Button asChild size="sm">
          <Link href="/campaigns/new">New campaign</Link>
        </Button>
      </PageHeader>
      <div className="p-6">
        {campaigns.length === 0 ? (
          <p className="text-sm text-muted-foreground">No campaigns yet.</p>
        ) : (
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Recipients</TableHead>
                  <TableHead>Sent</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      <Link href={`/campaigns/${c.id}`} className="hover:underline">
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.subject}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[c.status] ?? "outline"}>{c.status}</Badge>
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{c._count.recipients}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.sentAt ? c.sentAt.toLocaleDateString() : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </>
  );
}
