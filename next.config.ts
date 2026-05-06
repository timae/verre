import type { NextConfig } from 'next'

// Server Actions check the Origin header for CSRF. localhost:8080 is always
// allowed for local dev; deployed instances add their public hostname via
// SERVER_ACTIONS_ALLOWED_ORIGINS (comma-separated, host:port, no scheme).
const extraOrigins = (process.env.SERVER_ACTIONS_ALLOWED_ORIGINS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean)

const config: NextConfig = {
  output: 'standalone',
  experimental: {
    serverActions: { allowedOrigins: ['localhost:8080', ...extraOrigins] },
  },
}

export default config
