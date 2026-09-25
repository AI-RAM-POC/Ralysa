import { fontLicenses } from '@ralysa/ui/font-licenses';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// fontLicenses(): every bundled font's OFL text and THIRD_PARTY_NOTICES go into dist/, and a
// font from outside the reviewed packages fails the build (F-001 design §7.2, AC-8).
export default defineConfig({
  plugins: [react(), fontLicenses()],
  build: { sourcemap: false },
});
