/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    instrumentationHook: true,
  },
  webpack(config, { nextRuntime }) {
    // instrumentation.ts is compiled for BOTH the Node and the Edge server
    // bundles, and its dynamic import of ./lib/cron reaches src/lib/db.ts and
    // therefore `pg`, which needs fs/net/tls. The Node bundle treats pg as an
    // external (Next's default list) but the Edge bundle tries to bundle it
    // and fails on 'fs'. register() returns before that import on Edge, so an
    // empty stub is safe there. Nothing in this app opts into the Edge
    // runtime; if a route ever does, it must not touch the database.
    if (nextRuntime === 'edge') {
      config.resolve.alias = { ...config.resolve.alias, pg: false };
    }
    return config;
  },
};

module.exports = nextConfig;
