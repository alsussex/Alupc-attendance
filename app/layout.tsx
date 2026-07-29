import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { ServiceWorkerRegistration } from "@/components/pwa/ServiceWorkerRegistration";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    process.env.VERCEL_PROJECT_PRODUCTION_URL ??
    "church-attendance.invalid";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (process.env.NODE_ENV === "development" ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;
  const description = "A focused, offline-capable church attendance workspace.";
  return {
    title: { default: "Church Attendance", template: "%s · Church Attendance" },
    description,
    manifest: "/manifest.webmanifest",
    icons: { icon: "/favicon.svg" },
    openGraph: {
      title: "Church Attendance",
      description,
      images: [{ url: image, width: 1787, height: 909 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Church Attendance",
      description,
      images: [image],
    },
  };
}

export const viewport: Viewport = {
  themeColor: "#24493f",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <ServiceWorkerRegistration />
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
