"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { sendTrackedEmail } from "@/server/actions/email";

export function SendEmailDialog({
  contactId,
  dealId,
  disabled,
}: {
  contactId?: string;
  dealId?: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setBusy(true);
    const res = await sendTrackedEmail({
      contactId,
      dealId,
      subject: String(data.get("subject") || ""),
      body: String(data.get("body") || ""),
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.fieldErrors?.subject?.[0] ?? res.fieldErrors?.body?.[0] ?? res.error);
      return;
    }
    toast.success(res.data.status === "skipped" ? "Email recorded" : "Email sent");
    setOpen(false);
    router.refresh();
  }

  if (disabled) {
    return (
      <Button size="sm" variant="outline" disabled title="No email address on file">
        Send email
      </Button>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Send email</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send email</DialogTitle>
          <DialogDescription>Compose a message. It will be tracked on this record.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email-subject">Subject</Label>
            <Input id="email-subject" name="subject" required maxLength={200} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email-body">Message</Label>
            <Textarea id="email-body" name="body" required maxLength={20000} rows={8} />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
