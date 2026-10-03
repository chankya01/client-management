const localApiPort = process.env.LOCAL_API_PORT;

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    if (!localApiPort) return [];
    return [
      {
        source: "/api/:path*",
        destination: `http://127.0.0.1:${localApiPort}/api/:path*`
      }
    ];
  }
};

export default nextConfig;
