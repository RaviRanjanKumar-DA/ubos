import type { Metadata } from 'next';
import { Inter, Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';
import { DialogHost } from '@/components/Dialogs';

const body = Inter({ subsets: ['latin'], variable: '--font-body', display: 'swap' });
const heading = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-heading', display: 'swap' });

export const metadata: Metadata = {
  title: 'UBOS',
  description: 'Unified Business Operating System',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${body.variable} ${heading.variable}`}>
      <body>{children}<DialogHost /></body>
    </html>
  );
}
