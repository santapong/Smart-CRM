import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { hasRole } from "@/lib/rbac";
import { PageHeader } from "@/components/page-header";
import { ProductsSection } from "./products-section";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const { orgId, role } = await requireOrg();
  if (!hasRole(role, "ADMIN")) redirect("/dashboard");

  const products = await db.product.findMany({
    where: { orgId },
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });

  return (
    <>
      <PageHeader title="Products" description="Your product & service catalog for deal line items." />
      <div className="p-6">
        <ProductsSection
          products={products.map((p) => ({
            id: p.id,
            name: p.name,
            sku: p.sku,
            unit: p.unit,
            price: Number(p.price),
            cost: p.cost != null ? Number(p.cost) : null,
            currency: p.currency,
            active: p.active,
          }))}
        />
      </div>
    </>
  );
}
