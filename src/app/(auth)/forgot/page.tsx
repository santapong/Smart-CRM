import { ForgotForm } from "./forgot-form";

export default function ForgotPage() {
  return (
    <main className="container mx-auto flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border bg-card p-6 shadow-sm">
        <h1 className="mb-1 text-2xl font-semibold">Forgot password</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Enter your email and we&apos;ll send you a reset link.
        </p>
        <ForgotForm />
      </div>
    </main>
  );
}
