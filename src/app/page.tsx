import Link from "next/link";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function HomePage() {
  const session = await auth();
  if (session?.user) redirect("/dashboard");

  return (
    <main className="container mx-auto flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center">
      <h1 className="text-5xl font-bold tracking-tight">Smart CRM</h1>
      <p className="max-w-xl text-lg text-muted-foreground">
        A simple, fast CRM for small teams. Contacts, deals, activities and a Kanban pipeline — out of the box.
      </p>
      <div className="flex gap-3">
        <Link
          href="/login"
          className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Sign in
        </Link>
        <Link
          href="/signup"
          className="rounded-md border border-input bg-background px-5 py-2.5 text-sm font-medium hover:bg-accent"
        >
          Create account
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">
        Demo: <code>owner@demo.com</code> / <code>password123</code>
      </p>
    </main>
  );
}
