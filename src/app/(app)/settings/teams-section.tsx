"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { createTeam, deleteTeam, addTeamMember, removeTeamMember } from "@/server/actions/teams";

export type TeamMemberRow = { userId: string; name: string | null; email: string };
export type TeamRow = { id: string; name: string; members: TeamMemberRow[] };
export type OrgMember = { userId: string; name: string | null; email: string };

export function TeamsSection({ teams, members }: { teams: TeamRow[]; members: OrgMember[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");

  function onCreate() {
    if (name.trim().length < 2) {
      toast.error("Name must be at least 2 characters");
      return;
    }
    start(async () => {
      const r = await createTeam({ name: name.trim() });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Team created");
      setName("");
      router.refresh();
    });
  }

  function onDelete(id: string) {
    if (!confirm("Delete this team?")) return;
    start(async () => {
      const r = await deleteTeam(id);
      if (!r.ok) toast.error(r.error);
      else {
        toast.success("Deleted");
        router.refresh();
      }
    });
  }

  function onAdd(teamId: string, userId: string) {
    if (!userId) return;
    start(async () => {
      const r = await addTeamMember(teamId, userId);
      if (!r.ok) toast.error(r.error);
      else {
        toast.success("Member added");
        router.refresh();
      }
    });
  }

  function onRemove(teamId: string, userId: string) {
    start(async () => {
      const r = await removeTeamMember(teamId, userId);
      if (!r.ok) toast.error(r.error);
      else {
        toast.success("Removed");
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-6">
      {teams.length === 0 ? (
        <p className="text-sm text-muted-foreground">No teams yet.</p>
      ) : (
        <ul className="space-y-4">
          {teams.map((team) => {
            const memberIds = new Set(team.members.map((m) => m.userId));
            const candidates = members.filter((m) => !memberIds.has(m.userId));
            return (
              <li key={team.id} className="rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">{team.name}</p>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={pending}
                    aria-label="Delete team"
                    onClick={() => onDelete(team.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                {team.members.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {team.members.map((m) => (
                      <li
                        key={m.userId}
                        className="flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs"
                      >
                        {m.name ?? m.email}
                        <button
                          type="button"
                          aria-label={`Remove ${m.email}`}
                          disabled={pending}
                          onClick={() => onRemove(team.id, m.userId)}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {candidates.length > 0 && (
                  <select
                    defaultValue=""
                    disabled={pending}
                    onChange={(e) => {
                      onAdd(team.id, e.target.value);
                      e.currentTarget.value = "";
                    }}
                    className="mt-3 h-8 rounded-md border border-input bg-background px-2 text-xs"
                  >
                    <option value="">Add member…</option>
                    {candidates.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.name ?? m.email}
                      </option>
                    ))}
                  </select>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="grid gap-3 border-t pt-6 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="team-name">New team name</Label>
          <Input id="team-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="West region" />
        </div>
        <Button type="button" onClick={onCreate} disabled={pending}>
          {pending ? "Saving…" : "Create team"}
        </Button>
      </div>
    </div>
  );
}
