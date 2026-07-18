import type { Metadata, Viewport } from "next";
import {
  Space_Grotesk,
  Instrument_Serif,
  JetBrains_Mono,
} from "next/font/google";
import "./globals.css";
import AppRail from "./AppRail";
import ServiceWorkerRegister from "./ServiceWorkerRegister";

// "Paper" type system: Space Grotesk drives the UI, Instrument Serif sets the
// editorial display headings, JetBrains Mono carries every number.
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});
const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-instrument-serif",
  display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  applicationName: "Winnow",
  title: "Winnow — media triage",
  description: "Ingest, triage and export of NAS photos/videos.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Winnow",
    statusBarStyle: "default",
  },
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#f4f0e7",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      // The inline script below stamps data-gallery-aside on <html> before
      // hydration (restoring the collapsed filter sidebar without a reflow), so
      // the server markup intentionally differs here.
      suppressHydrationWarning
      className={`${spaceGrotesk.variable} ${instrumentSerif.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        {/* Pre-paint restore of the gallery's desktop filter-sidebar choice.
            GalleryShell persists it to localStorage; applying it here — before
            the tree paints — means a sidebar the user collapsed stays collapsed
            on reload with no open→closed reflow. Desktop only (min-width:761px);
            phones use the transient slide-in drawer. Keep the key and query in
            sync with ASIDE_KEY/ASIDE_MQ in GalleryShell.tsx. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(window.matchMedia("(min-width: 761px)").matches&&localStorage.getItem("winnow.gallery.aside")==="closed"){document.documentElement.setAttribute("data-gallery-aside","closed")}}catch(e){}`,
          }}
        />
        <div className="root">
          <AppRail />
          <div className="root-main">{children}</div>
        </div>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
