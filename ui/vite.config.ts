/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-only proxy so the browser never makes a cross-origin request to the
// kernel API: the kernel registers no CORS plugin (out of scope, ui/ only),
// and EventSource-style SSE plus Bearer auth headers don't play well with
// CORS preflight anyway. Same-origin in dev via this proxy, same-origin in
// prod because Fargate serves the built UI behind the API. See ui/README
// notes in the ship report for the deploy implication.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Deliberately not VITE_API_URL: that var is exposed to client code (see
  // src/api/client.ts) and setting it there makes the browser fetch the
  // API origin directly, bypassing this very proxy and hitting CORS. This
  // one is server-side only (no VITE_ prefix), so it never reaches the bundle.
  const apiTarget = env.API_PROXY_TARGET || 'http://localhost:4000';
  return {
    plugins: [react()],
    server: {
      proxy: {
        '/v1': { target: apiTarget, changeOrigin: true },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
    },
  };
});
