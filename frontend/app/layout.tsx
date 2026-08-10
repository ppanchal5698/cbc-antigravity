import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { ThemeProvider } from "@/components/shell/theme-provider";
import { ChromeProvider } from "@/components/shell/chrome-context";
import { AppSidebar, MobileNavDrawer } from "@/components/shell/app-sidebar";
import { TopBar } from "@/components/shell/top-bar";
import { CommandPalette } from "@/components/shell/command-palette";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-sans",
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
      className={`${plexSans.variable} ${plexMono.variable} h-full`}
    >
      <body className="flex min-h-full">
        <ThemeProvider>
          <ChromeProvider>
            <AppSidebar />
            <MobileNavDrawer />
            <div className="flex min-h-full min-w-0 flex-1 flex-col">
              <TopBar />
              <main className="flex min-h-0 flex-1 flex-col">{children}</main>
            </div>
            <CommandPalette />
            <Toaster
              position="bottom-right"
              toastOptions={{ className: "rounded-md font-sans" }}
            />
          </ChromeProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
