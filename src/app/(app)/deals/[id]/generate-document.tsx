"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { generateDocument } from "@/server/actions/documents";

export type TemplateOption = { id: string; name: string };

/**
 * "Generate document" affordance on a deal: pick a template and create a
 * Document for the deal (its linked contact/company merge fields fill in too).
 * On success, navigates to the new document.
 */
export function GenerateDocument({ dealId, templates }: { dealId: string; templates: TemplateOption[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");

  if (templates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No templates yet. Create one under Documents to generate from a deal.
      </p>
    );
  }

  function onGenerate() {
    if (!templateId) {
      toast.error("Pick a template");
      return;
    }
    start(async () => {
      const r = await generateDocument({ templateId, dealId });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Document generated");
      router.push(`/documents/${r.data.id}`);
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={templateId}
        onChange={(e) => setTemplateId(e.target.value)}
        className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm"
        aria-label="Template"
      >
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <Button type="button" size="sm" disabled={pending} onClick={onGenerate}>
        {pending ? "Generating…" : "Generate"}
      </Button>
    </div>
  );
}
