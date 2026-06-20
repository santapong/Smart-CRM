"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { createCustomRole, deleteCustomRole, assignRole } from "@/server/actions/roles";

// Permission options offered in the UI. Values are "action:subject" strings that
// must match the allowed set in src/lib/authz.ts.
const PERMISSION_OPTIONS: { value: string; label: string }[] = [
  { value: "manage:org", label: "Manage org settings" },
  { value: "manage:member", label: "Manage members" },
  { value: "manage:team", label: "Manage teams" },
  { value: "manage:role", label: "Manage roles" },
  { value: "read:contact", label: "Read contacts" },
  { value: "manage:contact", label: "Manage contacts" },
  { value: "read:company", label: "Read companies" },
  { value: "manage:company", label: "Manage companies" },
  { value: "read:deal", label: "Read deals" },
  { value: "manage:deal", label: "Manage deals" },
  { value: "manage:activity", label: "Manage activities" },
  { value: "manage:pipeline", label: "Manage pipelines" },
];

export type CustomRoleRow = { id: string; name: string; permissions: string[] };
export type RoleMember = {
  id: string;
  name: string | null;
  email: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  customRoleId: string | null;
};

export function RolesSection({
  roles,
  members,
}: {
  roles: CustomRoleRow[];
  members: RoleMember[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  function toggle(value: string) {
    setSelected((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  }

  function onCreate() {
    if (name.trim().length < 2) {
      toast.error("Name must be at least 2 characters");
      return;
    }
    start(async () => {
      const r = await createCustomRole({ name: name.trim(), permissions: selected });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Role created");
      setName("");
      setSelected([]);
      router.refresh();
    });
  }

  function onDelete(id: string) {
    if (!confirm("Delete this role? It will be unassigned from any members.")) return;
    start(async () => {
      const r = await deleteCustomRole(id);
      if (!r.ok) toast.error(r.error);
      else {
        toast.success("Deleted");
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">
        Custom roles <strong>add</strong> permissions on top of a member&apos;s base role
        (Owner/Admin/Member). They never remove access granted by the base role.
      </p>

      {roles.length === 0 ? (
        <p className="text-sm text-muted-foreground">No custom roles yet.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {roles.map((role) => (
            <li key={role.id} className="flex items-start justify-between gap-2 p-3">
              <div>
                <p className="text-sm font-medium">{role.name}</p>
                <p className="text-xs text-muted-foreground">
                  {role.permissions.length === 0 ? "No extra permissions" : role.permissions.join(", ")}
                </p>
              </div>
              <Button
                size="icon"
                variant="ghost"
                disabled={pending}
                aria-label="Delete role"
                onClick={() => onDelete(role.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-3 border-t pt-6">
        <div className="space-y-1.5">
          <Label htmlFor="role-name">New role name</Label>
          <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sales manager" />
        </div>
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-muted-foreground">Permissions</legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {PERMISSION_OPTIONS.map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(opt.value)}
                  onChange={() => toggle(opt.value)}
                  className="h-4 w-4 rounded border-input"
                />
                {opt.label}
              </label>
            ))}
          </div>
        </fieldset>
        <Button type="button" onClick={onCreate} disabled={pending}>
          {pending ? "Saving…" : "Create role"}
        </Button>
      </div>

      {roles.length > 0 && (
        <div className="space-y-3 border-t pt-6">
          <h3 className="text-xs font-medium text-muted-foreground">Assign roles to members</h3>
          <ul className="divide-y rounded-md border">
            {members.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 p-3">
                <div>
                  <p className="text-sm font-medium">{m.name ?? m.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {m.email} · base {m.role.toLowerCase()}
                  </p>
                </div>
                <select
                  value={m.customRoleId ?? ""}
                  disabled={pending}
                  onChange={(e) =>
                    start(async () => {
                      const r = await assignRole(m.id, e.target.value || null);
                      if (!r.ok) toast.error(r.error);
                      else toast.success("Role assigned");
                      router.refresh();
                    })
                  }
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="">No custom role</option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
