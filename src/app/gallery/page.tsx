"use client";

import Link from "next/link";
import GalleryShell from "./GalleryShell";

// Galerie « tous dossiers » (sans scope) — accès direct/power-user. La navigation
// principale passe désormais par les onglets de la page d'accueil ; ce lien n'y
// figure plus mais la route reste pour l'exploration globale et le deep-link.
export default function GalleryPage() {
  return (
    <div className="gallery-layout">
      <div className="topbar">
        <Link href="/" className="btn">←</Link>
        <h1>Gallery</h1>
        <span className="hint">all folders</span>
      </div>
      <GalleryShell />
    </div>
  );
}
