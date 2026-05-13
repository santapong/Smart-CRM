import Link from "next/link";
import { LoginForm } from "./login-form";

export default function LoginPage({ searchParams }: { searchParams: { from?: string; error?: string } }) {
  return (
    <main className="container mx-auto flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border bg-card p-6 shadow-sm">
        <h1 className="mb-1 text-2xl font-semibold">Sign in</h1>
        <p className="mb-6 text-sm text-muted-foreground">Welcome back to Smart CRM.</p>
        <LoginForm from={searchParams.from} error={searchParams.error} />
        <p className="mt-6 text-center text-sm text-muted-foreground">
          New here?{" "}
          <Link href="/signup" className="font-medium text-primary hover:underline">
            Create an account
          </Link>
        </p>
      </div>
    </main>
  );
}
