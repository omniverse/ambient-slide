import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ambient Slide",
  description: "Interactive ambient audio mixer",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
