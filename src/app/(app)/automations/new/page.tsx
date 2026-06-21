import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { PageHeader } from "@/components/page-header";
import { RECIPES } from "@/lib/workflows/recipes";
import { WorkflowEditor } from "../workflow-editor";
import { RecipePicker } from "../recipe-picker";

export default async function NewAutomationPage() {
  const { role } = await requireOrg();
  requireRole(role, "ADMIN");
  const recipes = RECIPES.map((r) => ({ key: r.key, name: r.name, description: r.description }));
  return (
    <>
      <PageHeader title="New automation" />
      <div className="grid gap-6 p-6 lg:grid-cols-3">
        <section className="lg:col-span-2 rounded-lg border bg-card p-6">
          <WorkflowEditor />
        </section>
        <aside className="rounded-lg border bg-card p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Start from a recipe
          </h3>
          <RecipePicker recipes={recipes} />
        </aside>
      </div>
    </>
  );
}
