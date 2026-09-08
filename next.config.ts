import type { NextConfig } from "next";
import path from "node:path";

const backend = process.env.BACKEND_INTERNAL_URL || "http://127.0.0.1:4000"

const nextConfig: NextConfig = {
  // Pin the workspace root to this project — the parent cmz-app/ directory
  // holds an unrelated app with its own lockfile, which otherwise makes
  // Turbopack guess the wrong root.
  turbopack: {
    root: path.resolve(__dirname),
  },
  // Produces a self-contained server bundle (node_modules pruned to only
  // what's needed at runtime) — see Dockerfile.
  output: "standalone",
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${backend}/api/:path*` },
      { source: "/socket.io/:path*", destination: `${backend}/socket.io/:path*` },
    ]
  },
};

export default nextConfig;
