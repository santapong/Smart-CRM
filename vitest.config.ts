import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    setupFiles: [],
    server: {
      deps: {
        // Process next-auth through Vite so the next/server alias below
        // applies; externalized, its bare "next/server" import crashes Node.
        inline: ["next-auth", "@auth/core", "@auth/prisma-adapter"],
      },
    },
  },
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(root, "src") },
      // next-auth imports the extensionless "next/server", which Node's ESM
      // resolver rejects under Vitest. Point it at the real file.
      { find: /^next\/server$/, replacement: "next/server.js" },
    ],
  },
});
