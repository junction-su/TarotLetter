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
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b border-twilight/50">
          <nav className="mx-auto flex max-w-2xl items-center justify-between px-4 py-4">
            <a href="/" className="text-xl tracking-wide text-lavender">
              TarotLetter
            </a>
            <a
              href="/new"
              className="rounded-lg bg-violet px-4 py-2 text-sm text-cream transition-colors hover:bg-violet-light"
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
