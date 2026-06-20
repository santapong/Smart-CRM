import Link from "next/link";
import { VerifyClient } from "./verify-client";

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <main className="container mx-auto flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border bg-card p-6 shadow-sm">
        <h1 className="mb-1 text-2xl font-semibold">Verify email</h1>
        <p className="mb-6 text-sm text-muted-foreground">Confirming your email address.</p>
        {token ? (
          <VerifyClient token={token} />
        ) : (
          <div className="space-y-4">
            <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              This verification link is missing a token.
            </p>
            <Link href="/login" className="font-medium text-primary hover:underline">
              Back to sign in
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
