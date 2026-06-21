"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { createSequence } from "@/server/actions/sequences";

export function NewSequenceForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");

  function onCreate() {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    start(async () => {
      const r = await createSequence({ name: name.trim() });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Sequence created");
      router.push(`/sequences/${r.data.id}`);
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="seq-name">Name</Label>
        <Input
          id="seq-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. New lead nurture"
        />
      </div>
      <Button type="button" onClick={onCreate} disabled={pending}>
        {pending ? "Creating…" : "Create sequence"}
      </Button>
    </div>
  );
}
