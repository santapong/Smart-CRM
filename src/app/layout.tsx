import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Smart CRM",
  description: "A simple, fast CRM for small teams.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background antialiased">
        {children}
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
