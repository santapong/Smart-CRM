import { requireOrg } from "@/lib/tenant";
import { hasFeature } from "@/lib/entitlements";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { AssistantBox } from "@/components/ai/assistant-box";

/**
 * AI assistant page (M14). Hosts the ask box backed by aiSearch. When the org's
 * plan lacks the `ai` feature we render an upgrade hint instead of the box.
 */
export default async function AssistantPage() {
  const { orgId } = await requireOrg();
  const aiEnabled = await hasFeature(orgId, "ai");

  return (
    <>
      <PageHeader title="AI Assistant" description="Ask about your pipeline or search your records." />
      <div className="mx-auto w-full max-w-3xl p-6">
        {aiEnabled ? (
          <AssistantBox />
        ) : (
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">
                The AI assistant is available on the Professional and Business plans. Upgrade your plan to enable it.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
