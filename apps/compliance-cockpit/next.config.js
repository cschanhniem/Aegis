/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@agentguard/core-schema'],
  // 'standalone' emits a self-contained .next/standalone/ that Tauri
  // ships as a sidecar (Node + Cockpit + only the deps that are
  // actually imported). This is what makes `cargo tauri build`
  // produce a single .dmg / .exe / .AppImage instead of requiring
  // the user to npm install first.
  output: 'standalone',
  env: {
    APP_VERSION: require('./package.json').version,
  },
};

module.exports = nextConfig;