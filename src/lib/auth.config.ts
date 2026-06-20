import type { NextAuthConfig } from "next-auth";

// Edge-safe NextAuth config. No Node-only deps (bcrypt, Prisma) live here.
// The full config (with Credentials + adapter) lives in src/lib/auth.ts.
export const authConfig = {
  pages: { signIn: "/login" },
  session: { strategy: "jwt" },
  providers: [],
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isPublic =
        nextUrl.pathname === "/" ||
        nextUrl.pathname.startsWith("/login") ||
        nextUrl.pathname.startsWith("/signup") ||
        nextUrl.pathname.startsWith("/verify") ||
        nextUrl.pathname.startsWith("/forgot") ||
        nextUrl.pathname.startsWith("/reset") ||
        nextUrl.pathname.startsWith("/api/auth") ||
        // SSO/SCIM scaffold (M16): authenticated by the IdP / SCIM token, not a
        // session — env-gated 501 until JACKSON_* is set. See src/lib/sso.ts.
        nextUrl.pathname.startsWith("/api/scim") ||
        nextUrl.pathname.startsWith("/api/email") ||
        nextUrl.pathname.startsWith("/api/forms") ||
        // Public REST API (M12): authenticated via API key (Bearer), not a
        // session — see src/lib/api/auth.ts.
        nextUrl.pathname.startsWith("/api/v1");
      if (isPublic) return true;
      return isLoggedIn;
    },
  },
} satisfies NextAuthConfig;
