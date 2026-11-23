import type { Metadata, Viewport } from "next";
import "./globals.css";
import { RegisterSW } from "@/components/register-sw";
import { Splash } from "@/components/splash";

export const metadata: Metadata = {
  title: "Blomp",
  description: "Kane proves your live site works. Blomp fixes it when it doesn't.",
  applicationName: "Blomp",
  appleWebApp: { capable: true, title: "Blomp", statusBarStyle: "default" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f2f7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">
        {children}
        <Splash />
        <RegisterSW />
      </body>
    </html>
  );
}
