import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { AuthCallbackRouter } from "@/components/auth/AuthCallbackRouter";
import { ToastProvider } from "@/components/feedback/ToastProvider";
import { ConfirmationProvider } from "@/components/feedback/ConfirmationProvider";
import { ServiceWorkerRegistration } from "@/components/pwa/ServiceWorkerRegistration";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { themeBootstrapScript } from "@/lib/theme/theme";
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
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0d10" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body>
        <AuthProvider>
          <ThemeProvider>
            <AuthCallbackRouter />
            <ToastProvider>
              <ConfirmationProvider>
                <ServiceWorkerRegistration />
                {children}
              </ConfirmationProvider>
            </ToastProvider>
          </ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
