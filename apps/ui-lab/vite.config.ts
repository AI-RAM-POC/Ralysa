import { fontLicenses } from '@ralysa/ui/font-licenses';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The internal demo app (F-001 design §7.6). Never shipped: `ralysa.shipped: false`, no
// Dockerfile, nothing in deploy/ references it, and nothing may depend on it (AC-13).
export default defineConfig({
  plugins: [react(), tailwindcss(), fontLicenses()],
  build: { sourcemap: false },
});
