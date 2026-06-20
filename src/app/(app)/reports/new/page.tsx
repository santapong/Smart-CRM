import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { ReportBuilder } from "./report-builder";

export const dynamic = "force-dynamic";

export default async function NewReportPage() {
  const { orgId } = await requireOrg();
  const pipelines = await db.pipeline.findMany({
    where: { orgId },
    orderBy: { order: "asc" },
    select: { id: true, name: true },
  });
  return (
    <>
      <PageHeader title="Report builder" description="Pick a report type, filters and chart, then save it." />
      <div className="p-6">
        <ReportBuilder pipelines={pipelines} />
      </div>
    </>
  );
}
