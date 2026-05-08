import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "FairShare | Expense Balancer",
  description: "Track shared expenses and calculate the simplest set of payments to settle up.",
  icons: {
    icon: "/favicon.png?v=2",
    apple: "/apple-touch-icon.png?v=2",
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
