import type { ReactNode } from "react";
import { AppShell } from "./_shell/AppShell";
import "./globals.css";

export const metadata = {
  title: { default: "Audience Reaction", template: "%s · Audience Reaction" },
  description: "Audience reaction analysis for YouTube videos: sentiment, topics and evidence (local prototype).",
  applicationName: "Audience Reaction",
  icons: {
    icon: [{ url: "/favicon.ico", sizes: "any" }, { url: "/icon-192.png", type: "image/png", sizes: "192x192" }],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport = { themeColor: "#0b1115", colorScheme: "dark" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
