import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/shell/theme-provider";
import { TopNav } from "@/components/shell/top-nav";
import { CommandPalette } from "@/components/shell/command-palette";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

// Archivo is variable on width (62-125) as well as weight. Loading the wdth
// axis is what lets `font-stretch` carry dense labels without a second family.
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-archivo",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "CBC Estimating",
  description:
    "Commercial estimating and pricing copilot for Construction Building Components, a division of The Hamilton Parker Company.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${archivo.variable} ${plexMono.variable} h-full`}
    >
      <body className="flex min-h-full flex-col">
        <ThemeProvider>
          <TopNav />
          <main className="flex min-h-0 flex-1 flex-col">{children}</main>
          <CommandPalette />
          <Toaster
            position="bottom-right"
            toastOptions={{ className: "rounded-none font-sans" }}
          />
        </ThemeProvider>
      </body>
    </html>
  );
}
