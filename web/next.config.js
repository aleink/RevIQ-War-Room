const path = require('path');

// Load env vars from the root .env file (bot and web share the same .env)
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pass server-side env vars
  env: {
    DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
  },
};

module.exports = nextConfig;
