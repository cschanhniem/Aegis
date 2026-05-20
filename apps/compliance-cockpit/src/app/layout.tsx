import type { Metadata } from 'next'
import { GeistMono } from 'geist/font/mono'
import { Inter, Instrument_Serif, Plus_Jakarta_Sans } from 'next/font/google'
import './globals.css'
import { Providers } from '@/components/providers'

// Body / UI — Söhne substitute
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
})

// Display / large headings — Tiempos substitute
const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  variable: '--font-serif',
  weight: ['400'],
  style: ['normal', 'italic'],
  display: 'swap',
})

// Retained only for the AEGIS wordmark in the sidebar (uses weight 800/900)
const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-plus-jakarta',
  weight: ['700', '800'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'AEGIS — AI Agent Intelligence & Security',
  description: 'Real-time monitoring and auditing for AI agents',
  icons: { icon: '/aegis-logo.png', apple: '/aegis-logo.png' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${instrumentSerif.variable} ${GeistMono.variable} ${plusJakarta.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/*
         * No-flash theme bootstrap. Runs before paint, reads the user's
         * saved preference from localStorage, and sets the .dark class
         * on <html> if they explicitly chose dark — or if they're on
         * 'system' and the OS prefers dark. Anything that depends on
         * CSS variables now renders correctly on first paint.
         */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function () {
                try {
                  var stored = localStorage.getItem('aegis:theme');
                  var sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                  var apply = stored === 'dark' || ((stored === 'system' || !stored) && sysDark);
                  if (apply) document.documentElement.classList.add('dark');
                  else if (stored === 'light') document.documentElement.classList.add('light');
                } catch (_) {}
              })();
            `,
          }}
        />
      </head>
      <body style={{ fontFamily: 'var(--font-inter), -apple-system, BlinkMacSystemFont, system-ui, sans-serif' }}>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
