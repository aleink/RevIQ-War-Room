/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Ensure env vars are accessible in server components
  env: {
    DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN,
  },
};

module.exports = nextConfig;
