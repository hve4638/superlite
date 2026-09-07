import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 이 파일만 node 에서 실행된다 — DOM tsconfig 에 @types/node 를 끌어오지 않기 위한 최소 선언
declare const process: { env: Record<string, string | undefined> };

// 릴리스 채널 주입 — build.sh --channel dev 가 export 하는 SUPERLITE_CHANNEL 을 <html data-channel>
// 로 굽는다. theme/accent.css 의 :root[data-channel=dev] 가 이걸로 보라 팔레트를 고른다.
// 런타임(/version)에 붙이면 첫 페인트에 stable 색이 잠깐 보이므로 빌드 시점에 박는다.
const channel = process.env.SUPERLITE_CHANNEL;
const channelPlugin = {
  name: 'superlite-channel',
  transformIndexHtml: (html: string) =>
    channel ? html.replace('<html ', `<html data-channel="${channel}" `) : html,
};

export default defineConfig({
  plugins: [vue(), channelPlugin],
  server: {
    host: true,
    port: 8793,
    // /ws 만 백엔드로 프록시 — 3층 토폴로지 (_docs/decision/process-topology.md).
    // 타깃은 backend 의 SUPERLITE_HTTP 기본값과 맞춰야 한다.
    proxy: {
      '/ws': {
        target: `http://${process.env.SUPERLITE_HTTP ?? '127.0.0.1:8795'}`,
        ws: true,
      },
    },
  },
});
