import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemedToaster } from "@/components/themed-toaster";
import "./globals.css";

export const metadata: Metadata = {
  title: "Smart CRM",
  description: "A simple, fast CRM for small teams.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
          <ThemedToaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
