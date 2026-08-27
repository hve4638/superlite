import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 이 파일만 node 에서 실행된다 — DOM tsconfig 에 @types/node 를 끌어오지 않기 위한 최소 선언
declare const process: { env: Record<string, string | undefined> };

export default defineConfig({
  plugins: [vue()],
  server: {
    host: true,
    port: 8793,
    // /ws 만 백엔드로 프록시 — 3층 토폴로지 (_docs/decision/process-topology.md).
    // 타깃은 backend 의 SUPERLIGHT_HTTP 기본값과 맞춰야 한다.
    proxy: {
      '/ws': {
        target: `http://${process.env.SUPERLIGHT_HTTP ?? '127.0.0.1:8795'}`,
        ws: true,
      },
    },
  },
});
