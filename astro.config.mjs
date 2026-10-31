import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone', bodySizeLimit: 524_288_000 }),
  integrations: [react()],
  session: false,
  server: ({ command }) => {
    if (command !== 'dev') return {};
    const origin = new URL(process.env.APP_ORIGIN ?? 'http://localhost:4321');
    return { port: Number(origin.port || (origin.protocol === 'https:' ? 443 : 80)) };
  },
  // Middleware enforces runtime APP_ORIGIN, with a loopback-only development exception.
  security: { checkOrigin: false },
  vite: {
    ssr: { external: ['bun', 'nodemailer'] },
    // Workers load these entry points lazily. Discovering them after file selection
    // otherwise causes a dev-server reload that discards the selected File objects.
    optimizeDeps: { include: [
      '@time-estimator/browser-preview',
      '@time-estimator/browser-preview/pose',
      '@time-estimator/browser-preview/geometry',
      '@time-estimator/browser-preview/three',
      '@time-estimator/browser-preview/worker',
      '@time-estimator/browser-preview/stl',
      '@time-estimator/browser-preview/fast',
    ] },
  },
});
