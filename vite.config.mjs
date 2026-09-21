// หน้าเว็บ Duoke Desk (React + Vite) — โค้ดอยู่ใน web/
//   npm run ui:dev    → http://localhost:5173 (proxy /api ไปที่ ui-server.js :5174)
//   npm run ui:build  → web/dist (ui-server.js เสิร์ฟให้เอง)
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.UI_PORT || 5174;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
  },
});
