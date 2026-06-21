"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { createImportJob, previewCsv, getImportJob } from "@/server/actions/imports";

type Entity = "contact" | "company";
type DupeMode = "skip" | "update" | "create";

// Mirrors the targetable fields in src/lib/import/runner.ts. Kept local so this
// client bundle doesn't pull in the server-only runner module.
const FIELDS: Record<Entity, { value: string; label: string }[]> = {
  contact: [
    { value: "firstName", label: "First name" },
    { value: "lastName", label: "Last name" },
    { value: "email", label: "Email" },
    { value: "phone", label: "Phone" },
    { value: "title", label: "Title" },
    { value: "notes", label: "Notes" },
  ],
  company: [
    { value: "name", label: "Name" },
    { value: "domain", label: "Domain" },
    { value: "industry", label: "Industry" },
    { value: "size", label: "Size" },
    { value: "notes", label: "Notes" },
  ],
};

const inputClass = "flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

type Preview = {
  headers: string[];
  rows: Record<string, string>[];
  suggestedMapping: Record<string, string>;
};

type JobResult = Awaited<ReturnType<typeof getImportJob>>;

export function ImportWizard() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [entity, setEntity] = useState<Entity>("contact");
  const [raw, setRaw] = useState("");
  const [dupeMode, setDupeMode] = useState<DupeMode>("skip");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Extract<JobResult, { ok: true }>["data"] | null>(null);

  function onPreview() {
    if (!raw.trim()) {
      toast.error("Paste some CSV first");
      return;
    }
    setResult(null);
    start(async () => {
      const r = await previewCsv({ entity, raw });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setPreview(r.data);
      setMapping(r.data.suggestedMapping);
    });
  }

  function onFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      setRaw(String(reader.result ?? ""));
      setPreview(null);
      setResult(null);
    };
    reader.readAsText(file);
  }

  function onRun() {
    if (!preview) return;
    const mapped = Object.values(mapping).filter((v) => v.length > 0);
    if (mapped.length === 0) {
      toast.error("Map at least one column");
      return;
    }
    start(async () => {
      const r = await createImportJob({ entity, raw, mapping, dupeMode });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      const job = await getImportJob(r.data.id);
      if (job.ok) setResult(job.data);
      toast.success("Import complete");
      router.refresh();
    });
  }

  return (
    <div className="max-w-3xl space-y-6">
      <section className="space-y-4 rounded-lg border bg-card p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="imp-entity">Import into</Label>
            <select
              id="imp-entity"
              value={entity}
              onChange={(e) => {
                setEntity(e.target.value as Entity);
                setPreview(null);
                setResult(null);
              }}
              className={inputClass}
            >
              <option value="contact">Contacts</option>
              <option value="company">Companies</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="imp-dupe">On duplicate</Label>
            <select id="imp-dupe" value={dupeMode} onChange={(e) => setDupeMode(e.target.value as DupeMode)} className={inputClass}>
              <option value="skip">Skip existing</option>
              <option value="update">Update existing</option>
              <option value="create">Always create</option>
            </select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="imp-csv">CSV</Label>
          <Textarea
            id="imp-csv"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={8}
            placeholder={"First name,Last name,Email\nAda,Lovelace,ada@example.com"}
            className="font-mono text-xs"
          />
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
            className="text-xs text-muted-foreground"
          />
        </div>

        <Button type="button" onClick={onPreview} disabled={pending} variant="outline">
          {pending ? "Working…" : "Preview & map"}
        </Button>
      </section>

      {preview && (
        <section className="space-y-4 rounded-lg border bg-card p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Map columns</h2>
          <div className="space-y-2">
            {preview.headers.map((header) => (
              <div key={header} className="grid grid-cols-2 items-center gap-3">
                <span className="truncate text-sm font-medium" title={header}>
                  {header}
                </span>
                <select
                  value={mapping[header] ?? ""}
                  onChange={(e) => setMapping((m) => ({ ...m, [header]: e.target.value }))}
                  className={inputClass}
                  aria-label={`Map ${header}`}
                >
                  <option value="">— ignore —</option>
                  {FIELDS[entity].map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          {preview.rows.length > 0 && (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    {preview.headers.map((h) => (
                      <th key={h} className="px-2 py-1 text-left font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 5).map((row, i) => (
                    <tr key={i} className="border-t">
                      {preview.headers.map((h) => (
                        <td key={h} className="px-2 py-1 text-muted-foreground">
                          {row[h]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Button type="button" onClick={onRun} disabled={pending}>
            {pending ? "Importing…" : "Run import"}
          </Button>
        </section>
      )}

      {result && (
        <section className="space-y-3 rounded-lg border bg-card p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Results</h2>
          <div className="flex flex-wrap gap-4 text-sm">
            <span>
              Created <strong className="tabular-nums">{result.created}</strong>
            </span>
            <span>
              Updated <strong className="tabular-nums">{result.updated}</strong>
            </span>
            <span>
              Failed <strong className="tabular-nums">{result.failed}</strong>
            </span>
            <span className="text-muted-foreground">
              of {result.totalRows} row{result.totalRows === 1 ? "" : "s"}
            </span>
          </div>
          {result.errors.length > 0 && (
            <ul className="divide-y rounded-md border text-xs">
              {result.errors.map((e, i) => (
                <li key={i} className="flex gap-3 p-2">
                  <span className="tabular-nums text-muted-foreground">Row {e.rowNumber}</span>
                  <span className="text-destructive">{e.message}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
