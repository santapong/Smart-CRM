"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { inviteMember, changeMemberRole, removeMember } from "@/server/actions/org";

type Member = { id: string; role: "OWNER" | "ADMIN" | "MEMBER"; userId: string; email: string; name: string | null };

export function MembersSection({ members }: { members: Member[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, start] = useTransition();

  async function invite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const form = new FormData(e.currentTarget);
    const r = await inviteMember(Object.fromEntries(form.entries()));
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Member added");
    (e.target as HTMLFormElement).reset();
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <ul className="divide-y rounded-md border">
        {members.map((m) => (
          <li key={m.id} className="flex items-center justify-between p-3">
            <div>
              <p className="text-sm font-medium">{m.name ?? m.email}</p>
              <p className="text-xs text-muted-foreground">{m.email}</p>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={m.role}
                onChange={(e) =>
                  start(async () => {
                    const r = await changeMemberRole(m.id, e.target.value as Member["role"]);
                    if (!r.ok) toast.error(r.error);
                    else toast.success("Role updated");
                    router.refresh();
                  })
                }
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              >
                <option value="OWNER">Owner</option>
                <option value="ADMIN">Admin</option>
                <option value="MEMBER">Member</option>
              </select>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  start(async () => {
                    if (!confirm(`Remove ${m.email}?`)) return;
                    const r = await removeMember(m.id);
                    if (!r.ok) toast.error(r.error);
                    else toast.success("Removed");
                    router.refresh();
                  })
                }
              >
                Remove
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <form onSubmit={invite} className="grid gap-3 border-t pt-6 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Temporary password</Label>
          <Input id="password" name="password" type="password" minLength={6} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="role">Role</Label>
          <select id="role" name="role" defaultValue="MEMBER" className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
            <option value="ADMIN">Admin</option>
            <option value="MEMBER">Member</option>
          </select>
        </div>
        <Button type="submit" disabled={busy} className="sm:col-span-2">
          {busy ? "Adding…" : "Add member"}
        </Button>
      </form>
    </div>
  );
}
