import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Los paquetes del monorepo se importan como fuente TypeScript.
  transpilePackages: ["@caja/core", "@caja/db"],
  serverExternalPackages: ["postgres", "pino"],
};

export default config;
