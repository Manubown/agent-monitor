import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Local-only tool: never phone home.
  poweredByHeader: false,
  // Served on loopback only, where gzip saves nothing and costs CPU on every live refresh of a large session page.
  compress: false,
};

export default nextConfig;
