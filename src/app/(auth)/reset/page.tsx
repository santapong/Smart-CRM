import Link from "next/link";
import { ResetForm } from "./reset-form";

export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <main className="container mx-auto flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border bg-card p-6 shadow-sm">
        <h1 className="mb-1 text-2xl font-semibold">Reset password</h1>
        <p className="mb-6 text-sm text-muted-foreground">Choose a new password for your account.</p>
        {token ? (
          <ResetForm token={token} />
        ) : (
          <div className="space-y-4">
            <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              This reset link is missing a token or has expired.
            </p>
            <Link href="/forgot" className="font-medium text-primary hover:underline">
              Request a new link
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
