/** @type {import('next').NextConfig} */
const noFraming = [{ key: 'X-Frame-Options', value: 'DENY' }, { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" }];

const nextConfig = {
  reactStrictMode: true,
  // The app and sign-in pages can never be shown inside another site (clickjacking); public forms (/f/…) can be embedded.
  async headers() {
    return ['/app/:path*', '/login', '/console/:path*', '/print/:path*'].map((source) => ({ source, headers: noFraming }));
  },
};

export default nextConfig;
