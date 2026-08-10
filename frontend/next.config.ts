import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Traced output, so the runtime image carries only what the server needs.
  output: "standalone",
  // `pg` loads optional native/dynamic modules that the bundler must not touch.
  serverExternalPackages: ["pg", "exceljs"],
  // Univer ships ESM that Next must transpile for the client bundle.
  transpilePackages: [
    "@univerjs/presets",
    "@univerjs/preset-sheets-core",
    "@mertdeveci55/univer-import-export",
  ],
};

export default nextConfig;
