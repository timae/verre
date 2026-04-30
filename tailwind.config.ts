import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: ['class', '[data-theme="dark"]'],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        accent:  'var(--accent)',
        accent2: 'var(--accent2)',
        fg:      'var(--fg)',
        'fg-dim': 'var(--fg-dim)',
        'fg-faint': 'var(--fg-faint)',
        bg:      'var(--bg)',
        bg2:     'var(--bg2)',
        bg3:     'var(--bg3)',
        bg4:     'var(--bg4)',
        border:  'var(--border)',
        border2: 'var(--border2)',
      },
      fontFamily: {
        mono: ['Manrope', 'sans-serif'],
        serif: ['Manrope', 'sans-serif'],
      },
      borderRadius: {
        card: '24px',
        sheet: '22px',
      },
    },
  },
  plugins: [],
}

export default config
