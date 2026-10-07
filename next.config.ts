import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// Baseline security headers for the local app. Comment text is untrusted input:
// it is rendered only as React text nodes, and the CSP below is a second line of defence.
// A nonce-based strict CSP is deferred to M12 (local-server hardening).
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Do not let `next dev` write AGENTS.md / CLAUDE.md into the repository.
  agentRules: false,
  // No framework chrome in the product UI: hides the Next.js dev-tools badge (and its theme preferences) in `next dev`.
  devIndicators: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
