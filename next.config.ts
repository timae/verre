import type { NextConfig } from 'next'

const config: NextConfig = {
  output: 'standalone',
  experimental: {
    serverActions: { allowedOrigins: ['localhost:8080', 'tasting.tgweb.li'] },
  },
}

export default config
