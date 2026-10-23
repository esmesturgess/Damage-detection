import type { Metadata } from "next";
import { Barlow_Condensed, Barlow_Semi_Condensed, IBM_Plex_Mono, League_Gothic } from "next/font/google";
import "./globals.css";

// One gothic family, from tall to readable: League Gothic for the name, Barlow
// Condensed for headings, Barlow Semi Condensed for reading, and a sturdy mono
// for coordinates, dates and labels.
const masthead = League_Gothic({
  variable: "--font-league",
  subsets: ["latin"],
  axes: ["wdth"],
});

const display = Barlow_Condensed({
  variable: "--font-heading",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  style: ["normal", "italic"],
});

const sans = Barlow_Semi_Condensed({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
});

const mono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Corroborator",
  description: "PWTT change screening, LightGBM burn classification, seismic confound, human verdict.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable} ${masthead.variable} h-full antialiased`}>
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
