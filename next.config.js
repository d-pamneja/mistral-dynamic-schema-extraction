/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["@mistralai/mistralai"],
  },
};

module.exports = nextConfig;
