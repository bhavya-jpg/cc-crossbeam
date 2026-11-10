import type { Metadata } from "next"
import { Newsreader, Geist, Geist_Mono } from "next/font/google"
import { BRAND } from "@/lib/brand"
import "./globals.css"

// Headlines only.
const serif = Newsreader({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["400", "500"],
  style: ["normal", "italic"],
  display: "swap",
})

const sans = Geist({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
})

// Data only: model IDs, latency, cost.
const mono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
})

export const metadata: Metadata = {
  title: {
    default: `${BRAND.name} | ${BRAND.descriptor}`,
    template: `%s | ${BRAND.name}`,
  },
  description: BRAND.tagline,
  applicationName: BRAND.name,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body className="antialiased bg-structura">
        {children}
      </body>
    </html>
  )
}
