"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { addAccountTeamMember, removeAccountTeamMember } from "@/server/actions/account-team";

type Member = {
  id: string;
  role: "OWNER" | "AE" | "SE" | "CSM" | "EXEC_SPONSOR";
  user: { id: string; name: string | null; email: string };
};
type AvailableUser = { id: string; name: string | null; email: string };

const ROLE_OPTIONS: { value: Member["role"]; label: string }[] = [
  { value: "OWNER", label: "Owner" },
  { value: "AE", label: "AE" },
  { value: "SE", label: "SE" },
  { value: "CSM", label: "CSM" },
  { value: "EXEC_SPONSOR", label: "Exec Sponsor" },
];

const ROLE_LABEL: Record<Member["role"], string> = {
  OWNER: "Owner",
  AE: "AE",
  SE: "SE",
  CSM: "CSM",
  EXEC_SPONSOR: "Exec Sponsor",
};

export function AccountTeamPanel({
  companyId,
  members,
  availableUsers,
}: {
  companyId: string;
  members: Member[];
  availableUsers: AvailableUser[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, start] = useTransition();

  async function onAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const input = {
      companyId,
      userId: String(form.get("userId") ?? ""),
      role: String(form.get("role") ?? ""),
    };
    if (!input.userId) {
      toast.error("Select a user");
      return;
    }
    setBusy(true);
    const r = await addAccountTeamMember(input);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Added to team");
    (e.target as HTMLFormElement).reset();
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">No team members yet.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {members.map((m) => (
            <li key={m.id} className="flex items-center justify-between p-3">
              <div>
                <p className="text-sm font-medium">{m.user.name ?? m.user.email}</p>
                <p className="text-xs text-muted-foreground">{m.user.email}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
                  {ROLE_LABEL[m.role]}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    start(async () => {
                      if (!confirm(`Remove ${m.user.email} from this account?`)) return;
                      const r = await removeAccountTeamMember(m.id);
                      if (!r.ok) {
                        toast.error(r.error);
                        return;
                      }
                      toast.success("Removed");
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
      )}

      <form onSubmit={onAdd} className="grid gap-3 border-t pt-4 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="userId">User</Label>
          <select
            id="userId"
            name="userId"
            required
            defaultValue=""
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="" disabled>
              Select a user
            </option>
            {availableUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name ? `${u.name} (${u.email})` : u.email}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="role">Role</Label>
          <select
            id="role"
            name="role"
            defaultValue="AE"
            className="flex h-9 w-40 rounded-md border border-input bg-background px-3 text-sm"
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={busy || availableUsers.length === 0}>
          {busy ? "Adding…" : "Add"}
        </Button>
      </form>
    </div>
  );
}
