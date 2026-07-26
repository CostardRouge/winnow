/** @type {import('next').NextConfig} */
const nextConfig = {
  // sharp + exiftool-vendored + pg ship native/binary code that must not be
  // bundled on the server side: keep them external (loaded from node_modules).
  serverExternalPackages: ["sharp", "exiftool-vendored", "pg"],
  experimental: {
    // TypeScript 7 is the native (Go) compiler: it ships a CLI but no longer the
    // JS compiler API Next.js drives by default, so the build aborts with
    // "TypeScript 7.0.2 does not provide the compiler API required by Next.js".
    // This flag makes Next shell out to the project-local `tsc` instead — the
    // same binary `npm run typecheck` uses.
    useTypeScriptCli: true,
  },
  devIndicators: false,
};

export default nextConfig;
