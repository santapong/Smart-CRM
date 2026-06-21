"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { createSignatureRequest } from "@/server/actions/esign";

/**
 * "Request signature" affordance on a Document. Collects comma/newline-separated
 * signer emails and calls createSignatureRequest. Shows whether eSign is live or
 * scaffolded; either way the request is recorded.
 */
export function RequestSignature({ documentId, configured }: { documentId: string; configured: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [emails, setEmails] = useState("");

  function onSubmit() {
    const signers = emails
      .split(/[\s,]+/)
      .map((e) => e.trim())
      .filter(Boolean)
      .map((email) => ({ email }));
    if (signers.length === 0) {
      toast.error("Enter at least one signer email");
      return;
    }
    start(async () => {
      const r = await createSignatureRequest({ documentId, signers });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      // The action returns a message describing the configured/unconfigured path.
      if (r.data.configured) toast.success(r.data.message);
      else toast.message(r.data.message);
      setEmails("");
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      {!configured && (
        <p className="rounded-md border border-dashed bg-muted/40 p-2 text-[11px] text-muted-foreground">
          eSign is in scaffold mode. Set <code>DROPBOX_SIGN_API_KEY</code> to send for real — requests are
          still recorded.
        </p>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="signer-emails" className="text-xs">
          Signer emails
        </Label>
        <Input
          id="signer-emails"
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          placeholder="ada@acme.com, sam@acme.com"
        />
      </div>
      <Button type="button" size="sm" className="w-full" disabled={pending} onClick={onSubmit}>
        {pending ? "Requesting…" : "Request signature"}
      </Button>
    </div>
  );
}
