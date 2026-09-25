const localApiPort = process.env.LOCAL_API_PORT || "8000";

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `http://127.0.0.1:${localApiPort}/api/:path*`
      }
    ];
  }
};

export default nextConfig;
