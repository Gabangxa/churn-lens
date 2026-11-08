/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    instrumentationHook: true,
  },
  // No page of this app is meant to be framed — not by another site, not by
  // itself. Above all /login/confirm: its one button spends a magic link, and
  // a page that framed it invisibly could get it pressed (clickjacking).
  // SameSite=Lax already keeps a framed cross-site sign-in from storing its
  // cookie; this refuses the frame outright. frame-ancestors is the modern
  // control, X-Frame-Options the one older browsers still read.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        ],
      },
    ];
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
