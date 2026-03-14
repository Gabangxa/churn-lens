/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['@react-email/components'],
    instrumentationHook: true,
  },
};

module.exports = nextConfig;
