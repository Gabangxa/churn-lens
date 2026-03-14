/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['@react-email/components'],
  },
};

module.exports = nextConfig;
