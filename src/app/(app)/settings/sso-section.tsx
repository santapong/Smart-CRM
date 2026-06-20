"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  createSSOConnection,
  updateSSOConnection,
  deleteSSOConnection,
  activateSSOConnection,
  deactivateSSOConnection,
} from "@/server/actions/sso";

export type SSOConnectionRow = {
  id: string;
  label: string | null;
  status: string;
  hasMetadata: boolean;
};

export function SSOSection({
  connections,
  configured,
}: {
  connections: SSOConnectionRow[];
  configured: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [label, setLabel] = useState("");
  const [metadataXml, setMetadataXml] = useState("");

  function onCreate() {
    if (!metadataXml.trim()) {
      toast.error("Paste your IdP SAML metadata XML");
      return;
    }
    start(async () => {
      const r = await createSSOConnection({ label: label.trim(), metadataXml: metadataXml.trim() });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("SSO connection saved");
      setLabel("");
      setMetadataXml("");
      router.refresh();
    });
  }

  function onDelete(id: string) {
    if (!confirm("Delete this SSO connection?")) return;
    start(async () => {
      const r = await deleteSSOConnection(id);
      if (!r.ok) toast.error(r.error);
      else {
        toast.success("Deleted");
        router.refresh();
      }
    });
  }

  function onToggle(c: SSOConnectionRow) {
    start(async () => {
      const r =
        c.status === "active" ? await deactivateSSOConnection(c.id) : await activateSSOConnection(c.id);
      if (!r.ok) toast.error(r.error);
      else {
        toast.success(c.status === "active" ? "Deactivated" : "Activated");
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-6">
      {!configured && (
        <p className="rounded-md border border-dashed bg-muted/40 p-3 text-xs text-muted-foreground">
          SSO is in scaffold mode. Set <code>JACKSON_*</code> environment variables to enable the live
          SAML flow. You can still store IdP metadata below.
        </p>
      )}

      {connections.length === 0 ? (
        <p className="text-sm text-muted-foreground">No SSO connections.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {connections.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 p-3">
              <div>
                <p className="text-sm font-medium">{c.label ?? "SAML connection"}</p>
                <p className="text-xs text-muted-foreground">
                  {c.status} · {c.hasMetadata ? "metadata stored" : "no metadata"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={pending} onClick={() => onToggle(c)}>
                  {c.status === "active" ? "Deactivate" : "Activate"}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={pending}
                  aria-label="Delete connection"
                  onClick={() => onDelete(c.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-3 border-t pt-6">
        <div className="space-y-1.5">
          <Label htmlFor="sso-label">Label (optional)</Label>
          <Input id="sso-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Okta" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sso-metadata">IdP SAML metadata (XML)</Label>
          <textarea
            id="sso-metadata"
            value={metadataXml}
            onChange={(e) => setMetadataXml(e.target.value)}
            rows={5}
            placeholder="<EntityDescriptor ...>…</EntityDescriptor>"
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
          />
        </div>
        <Button type="button" onClick={onCreate} disabled={pending}>
          {pending ? "Saving…" : "Save SSO connection"}
        </Button>
      </div>
    </div>
  );
}
