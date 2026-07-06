import type { Metadata, Viewport } from "next";
import { Orbitron, Rajdhani, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const orbitron = Orbitron({
  subsets: ["latin"],
  weight: ["500", "700", "900"],
  variable: "--font-orbitron",
});
const rajdhani = Rajdhani({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-rajdhani",
});
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-inter",
});
const jbmono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "600"],
  variable: "--font-jbmono",
});

export const metadata: Metadata = {
  title: "BRIGHT OS",
  description: "Mission control for the Bright empire",
};

export const viewport: Viewport = {
  themeColor: "#050A14",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        className={`${orbitron.variable} ${rajdhani.variable} ${inter.variable} ${jbmono.variable} f-inter`}
        style={{ fontSize: 13 }}
      >
        {children}
      </body>
    </html>
  );
}
