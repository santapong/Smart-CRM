"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { verifyEmailAction } from "@/server/actions/auth";

type State = { status: "pending" } | { status: "success" } | { status: "error"; message: string };

export function VerifyClient({ token }: { token: string }) {
  const [state, setState] = useState<State>({ status: "pending" });

  useEffect(() => {
    let active = true;
    verifyEmailAction(token).then((res) => {
      if (!active) return;
      if (res.ok) setState({ status: "success" });
      else setState({ status: "error", message: res.error });
    });
    return () => {
      active = false;
    };
  }, [token]);

  if (state.status === "pending") {
    return <p className="text-sm text-muted-foreground">Verifying your email…</p>;
  }

  if (state.status === "success") {
    return (
      <div className="space-y-4">
        <p className="text-sm">Email verified — you can now sign in.</p>
        <Link href="/login" className="font-medium text-primary hover:underline">
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
        {state.message}
      </p>
      <Link href="/login" className="font-medium text-primary hover:underline">
        Back to sign in
      </Link>
    </div>
  );
}
