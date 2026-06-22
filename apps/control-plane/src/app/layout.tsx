import './globals.css'
import type { ReactNode } from 'react'

export const metadata = {
  title: 'AEGIS — sign in',
  description: 'Hosted AEGIS — sign in or create an org.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
