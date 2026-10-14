import type { Metadata, Viewport } from "next";
import { PwaProvider } from "../components/pwa";
import "../styles/globals.css";

export const metadata: Metadata = {
  title: "Ramin Life OS",
  description: "A private workspace for your tasks, projects and time.",
  robots: { index: false, follow: false },
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Ramin Life OS",
    statusBarStyle: "default",
  },
  icons: { apple: "/icons/life-os-192.png" },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#15171c",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fa" dir="rtl">
      <body>
        <PwaProvider>{children}</PwaProvider>
      </body>
    </html>
  );
}
