import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/tenant";
import { hasRole } from "@/lib/rbac";
import { listIntegrations } from "@/server/actions/integrations";
import { nangoConfigured } from "@/lib/integrations/nango";
import { PageHeader } from "@/components/page-header";
import { IntegrationsDirectory } from "./integrations-directory";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const { role } = await requireOrg();
  if (!hasRole(role, "ADMIN")) redirect("/dashboard");

  const res = await listIntegrations();
  const providers = res.ok ? res.data : [];

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Connect Smart CRM to the tools your team already uses."
      />
      <div className="p-6">
        <IntegrationsDirectory providers={providers} nangoConfigured={nangoConfigured()} />
      </div>
    </>
  );
}
