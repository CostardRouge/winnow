import type { MetadataRoute } from "next";

// Web App Manifest (served at /manifest.webmanifest by Next.js). Drives the
// install experience on Chrome/Edge desktop and Android. iOS reads the icons
// here too but relies mostly on the <meta apple-*> tags wired in layout.tsx.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Winnow — media triage",
    short_name: "Winnow",
    description:
      "Ingest, triage and export of NAS photos and videos — index, cull and export without ever touching the originals more than once.",
    id: "/",
    start_url: "/library",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#f4f0e7",
    theme_color: "#f4f0e7",
    categories: ["photo", "productivity", "utilities"],
    lang: "en",
    dir: "ltr",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
    shortcuts: [
      {
        name: "Sift — swipe triage",
        short_name: "Sift",
        url: "/sift",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Library",
        short_name: "Library",
        url: "/library",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Gallery",
        short_name: "Gallery",
        url: "/gallery",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Import",
        short_name: "Import",
        url: "/import",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
    ],
  };
}
