import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrg } from "@/lib/tenant";
import { db } from "@/lib/db";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency } from "@/lib/utils";
import { runReport, isReportKind, type ReportSpec, type ReportResult } from "@/lib/reports/runners";
import { ReportChart, type ChartType } from "../report-chart";
import { DeleteReportButton } from "./delete-report-button";
import { ArrowLeft } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ReportViewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireOrg();
  const report = await db.report.findFirst({ where: { id, orgId } });
  if (!report || !isReportKind(report.kind)) notFound();

  const result = await runReport(orgId, report.kind, (report.spec as ReportSpec) ?? {});
  const chartType = (["bar", "line", "area", "pie"].includes(report.chartType) ? report.chartType : "bar") as ChartType;

  return (
    <>
      <PageHeader title={report.name} description={`${report.kind} · ${chartType} chart`}>
        <Button asChild variant="ghost" size="sm">
          <Link href="/reports">
            <ArrowLeft className="h-4 w-4" /> Back
          </Link>
        </Button>
        <DeleteReportButton id={report.id} />
      </PageHeader>
      <div className="space-y-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle>{report.name}</CardTitle>
          </CardHeader>
          <CardContent>
            <ReportChart result={result} chartType={chartType} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Data</CardTitle>
          </CardHeader>
          <CardContent>
            <ResultTable result={result} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function ResultTable({ result }: { result: ReportResult }) {
  switch (result.kind) {
    case "funnel":
      return (
        <SimpleTable
          head={["Stage", "Deals entered", "Conversion"]}
          rows={result.rows.map((r) => [r.name, String(r.entries), r.conversionFromPrev == null ? "—" : `${r.conversionFromPrev}%`])}
        />
      );
    case "velocity":
      return (
        <SimpleTable
          head={["Stage", "Avg days", "Samples"]}
          rows={result.rows.map((r) => [r.name, String(r.avgDays), String(r.samples)])}
        />
      );
    case "win_loss":
      return (
        <SimpleTable
          head={["Segment", "Won", "Lost", "Won value", "Win rate"]}
          rows={result.rows.map((r) => [r.label, String(r.won), String(r.lost), formatCurrency(r.wonValue), `${r.winRate}%`])}
        />
      );
    case "lead_source":
      return (
        <SimpleTable
          head={["Source", "Leads", "Converted", "Revenue"]}
          rows={result.rows.map((r) => [r.source, String(r.leads), String(r.converted), formatCurrency(r.revenue)])}
        />
      );
    case "pipeline_value":
      return (
        <SimpleTable
          head={["Stage", "Open value", "Weighted", "Deals"]}
          rows={result.rows.map((r) => [r.name, formatCurrency(r.value), formatCurrency(r.weighted), String(r.count)])}
        />
      );
    case "activity":
      return (
        <SimpleTable
          head={["Type", "Created", "Completed"]}
          rows={result.byType.map((r) => [r.label, String(r.created), String(r.completed)])}
        />
      );
    default:
      return null;
  }
}

function SimpleTable({ head, rows }: { head: string[]; rows: string[][] }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No data.</p>;
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            {head.map((h) => (
              <TableHead key={h}>{h}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              {r.map((c, j) => (
                <TableCell key={j} className={j === 0 ? "font-medium" : "text-muted-foreground"}>
                  {c}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
