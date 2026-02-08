import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TarotLetter",
  description: "A personal tarot reading journal — letters from the future.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen antialiased">
        <header className="border-b border-twilight/40">
          <nav className="mx-auto flex max-w-2xl items-center justify-between px-4 py-4">
            <a
              href="/"
              className="text-lg font-semibold tracking-tight text-lavender"
            >
              TarotLetter
            </a>
            <a
              href="/new"
              className="rounded-lg bg-violet px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-violet-light"
            >
              + New Reading
            </a>
          </nav>
        </header>
        <main className="mx-auto max-w-2xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
