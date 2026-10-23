import type { Metadata } from "next";
import { Courier_Prime, League_Gothic, Newsreader, Schibsted_Grotesk } from "next/font/google";
import "./globals.css";

// Case-file type: a news serif for titles, a news grotesk for reading, and a
// typewriter for coordinates, dates and IDs.
const display = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  style: ["normal", "italic"],
});

const sans = Schibsted_Grotesk({
  variable: "--font-schibsted",
  subsets: ["latin"],
});

// Tall condensed capitals for the name block.
const masthead = League_Gothic({
  variable: "--font-league",
  subsets: ["latin"],
  axes: ["wdth"],
});

const mono = Courier_Prime({
  variable: "--font-courier",
  subsets: ["latin"],
  weight: ["400", "700"],
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
