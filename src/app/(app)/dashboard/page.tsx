import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PipelineChart } from "./pipeline-chart";
import { formatCurrency } from "@/lib/utils";
import { format } from "date-fns";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { orgId } = await requireOrg();

  const [stages, openDeals, wonDeals, lostDeals, activities, contactCount, companyCount] = await Promise.all([
    db.pipelineStage.findMany({ where: { orgId }, orderBy: { order: "asc" } }),
    db.deal.findMany({ where: { orgId, status: "OPEN" } }),
    db.deal.findMany({ where: { orgId, status: "WON" } }),
    db.deal.findMany({ where: { orgId, status: "LOST" } }),
    db.activity.findMany({
      where: { orgId, completedAt: null },
      include: { contact: true, deal: true },
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }],
      take: 8,
    }),
    db.contact.count({ where: { orgId } }),
    db.company.count({ where: { orgId } }),
  ]);

  const pipelineValue = openDeals.reduce((s, d) => s + Number(d.value), 0);
  const wonValue = wonDeals.reduce((s, d) => s + Number(d.value), 0);
  const closedCount = wonDeals.length + lostDeals.length;
  const winRate = closedCount === 0 ? 0 : Math.round((wonDeals.length / closedCount) * 100);

  const chartData = stages.map((s) => ({
    name: s.name,
    value: openDeals.filter((d) => d.stageId === s.id).reduce((sum, d) => sum + Number(d.value), 0),
    color: s.color,
  }));

  return (
    <>
      <PageHeader title="Dashboard" description="Pipeline and activity at a glance." />
      <div className="grid gap-4 p-6 md:grid-cols-4">
        <Stat label="Open pipeline" value={formatCurrency(pipelineValue)} sub={`${openDeals.length} deals`} />
        <Stat label="Won (all-time)" value={formatCurrency(wonValue)} sub={`${wonDeals.length} deals`} />
        <Stat label="Win rate" value={`${winRate}%`} sub={`${closedCount} closed`} />
        <Stat label="People · Companies" value={`${contactCount} · ${companyCount}`} sub="In your CRM" />
      </div>
      <div className="grid gap-4 px-6 pb-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Pipeline value by stage</CardTitle>
          </CardHeader>
          <CardContent>
            <PipelineChart data={chartData} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Up next</CardTitle>
          </CardHeader>
          <CardContent>
            {activities.length === 0 ? (
              <p className="text-sm text-muted-foreground">All caught up.</p>
            ) : (
              <ul className="space-y-3 text-sm">
                {activities.map((a) => (
                  <li key={a.id} className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{a.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {a.dueAt ? format(a.dueAt, "PP") : "No due date"}
                        {a.contact && (
                          <>
                            {" · "}
                            <Link href={`/contacts/${a.contact.id}`} className="hover:underline">
                              {a.contact.firstName} {a.contact.lastName}
                            </Link>
                          </>
                        )}
                      </p>
                    </div>
                    <span className="text-[10px] text-muted-foreground">{a.type}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
