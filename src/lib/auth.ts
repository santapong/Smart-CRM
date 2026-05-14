import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { authConfig } from "@/lib/auth.config";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      activeOrgId?: string | null;
      role?: "OWNER" | "ADMIN" | "MEMBER" | null;
    } & DefaultSession["user"];
  }
}

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(db),
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const user = await db.user.findUnique({ where: { email: parsed.data.email } });
        if (!user?.passwordHash) return null;
        const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
        if (!ok) return null;
        return { id: user.id, email: user.email, name: user.name, image: user.image };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, user, trigger, session }) {
      if (user) token.sub = user.id as string;
      if (trigger === "update" && session?.activeOrgId) {
        token.activeOrgId = session.activeOrgId;
      }
      if (token.sub && !token.activeOrgId) {
        const m = await db.membership.findFirst({
          where: { userId: token.sub as string },
          orderBy: { createdAt: "asc" },
        });
        if (m) {
          token.activeOrgId = m.orgId;
          token.role = m.role;
        }
      } else if (token.sub && token.activeOrgId) {
        const m = await db.membership.findFirst({
          where: { userId: token.sub as string, orgId: token.activeOrgId as string },
        });
        token.role = m?.role ?? null;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
        session.user.activeOrgId = (token.activeOrgId as string) ?? null;
        session.user.role = (token.role as "OWNER" | "ADMIN" | "MEMBER") ?? null;
      }
      return session;
    },
  },
});
