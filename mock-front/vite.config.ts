import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: true,
    port: 8793,
    // /ws 만 백엔드로 프록시 — 3층 토폴로지 (_docs/decision/process-topology.md).
    // 타깃은 backend 의 SUPERLIGHT_HTTP 기본값과 맞춰야 한다.
    proxy: { '/ws': { target: 'http://127.0.0.1:8795', ws: true } },
  },
});
