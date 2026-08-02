import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { AuthCallbackRouter } from "@/components/auth/AuthCallbackRouter";
import { ToastProvider } from "@/components/feedback/ToastProvider";
import { UndoHistorySession } from "@/components/feedback/UndoHistorySession";
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
    applicationName: "ALUPC Attendance",
    title: { default: "ALUPC Attendance", template: "%s · ALUPC Attendance" },
    description,
    manifest: "/manifest.webmanifest",
    icons: {
      icon: [
        { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
        { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      ],
      shortcut: "/favicon-32.png",
      apple: [
        {
          url: "/apple-touch-icon.png",
          sizes: "180x180",
          type: "image/png",
        },
      ],
    },
    appleWebApp: {
      capable: true,
      title: "ALUPC Attendance",
      statusBarStyle: "black-translucent",
    },
    openGraph: {
      title: "ALUPC Attendance",
      description,
      images: [{ url: image, width: 1787, height: 909 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "ALUPC Attendance",
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
              <UndoHistorySession />
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
