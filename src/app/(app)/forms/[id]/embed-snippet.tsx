"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

type Field = { key: string; label: string; type: string; required?: boolean };

export function EmbedSnippet({ formId, fields }: { formId: string; fields: Field[] }) {
  const [origin, setOrigin] = useState("https://your-app.example.com");

  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin);
  }, []);

  const action = `${origin}/api/forms/${formId}/submit`;
  const inputs = fields
    .map((f) => {
      const tag = f.type === "textarea" ? "textarea" : "input";
      const typeAttr = tag === "input" ? ` type="${f.type === "tel" ? "tel" : f.type}"` : "";
      const req = f.required ? " required" : "";
      const open =
        tag === "textarea"
          ? `<textarea name="${f.key}"${req}></textarea>`
          : `<input name="${f.key}"${typeAttr}${req} />`;
      return `  <label>${f.label}\n    ${open}\n  </label>`;
    })
    .join("\n");

  const snippet = `<form action="${action}" method="POST">
${inputs}
  <!-- honeypot: leave empty -->
  <input type="text" name="_hp" style="display:none" tabindex="-1" autocomplete="off" />
  <button type="submit">Submit</button>
</form>`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      toast.success("Snippet copied");
    } catch {
      toast.error("Copy failed");
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Paste this on your site to capture leads.</p>
        <Button type="button" size="sm" variant="outline" onClick={copy}>
          <Copy className="h-3.5 w-3.5" /> Copy
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md border bg-muted p-3 text-xs">
        <code>{snippet}</code>
      </pre>
    </div>
  );
}
