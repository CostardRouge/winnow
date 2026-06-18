/** @type {import('next').NextConfig} */
const nextConfig = {
  // sharp + exiftool-vendored + pg embarquent du natif/binaire qu'il ne faut
  // pas bundler côté serveur : on les garde externes (chargés depuis node_modules).
  serverExternalPackages: ["sharp", "exiftool-vendored", "pg"],
  // Le lint tourne séparément (npm run lint) ; on ne bloque pas le build dessus.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
