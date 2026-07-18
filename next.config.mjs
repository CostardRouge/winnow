/** @type {import('next').NextConfig} */
const nextConfig = {
  // sharp + exiftool-vendored + pg ship native/binary code that must not be
  // bundled on the server side: keep them external (loaded from node_modules).
  serverExternalPackages: ["sharp", "exiftool-vendored", "pg"],
  // Lint runs separately (npm run lint); don't block the build on it.
  eslint: { ignoreDuringBuilds: true },
	devIndicators: false
};

export default nextConfig;
