import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone', bodySizeLimit: 524_288_000 }),
  integrations: [react()],
  session: false,
  // Our middleware checks every mutation against runtime APP_ORIGIN, rather than
  // deriving trust from Host/forwarded headers or baking a domain into the build.
  security: { checkOrigin: false },
  vite: { ssr: { external: ['bun', 'nodemailer'] } },
});
