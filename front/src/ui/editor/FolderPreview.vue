<script setup lang="ts">
import { ref, watch } from 'vue';
import type { DirEntry, Unopenable } from '../../backend/types';
import { editors, imageMime } from '../../model/editors';
import { files } from '../../model/files';
import { backend } from '../../model/host';
import FolderColumn from './FolderColumn.vue';
import HexView from './HexView.vue';
import ImageView from './ImageView.vue';

// 폴더 탭의 미리보기 — 커서 항목이 폴더면 그 나열(FolderColumn, 나열 참조는 FolderView 가
// acquireDir 로 든다), 파일이면 텍스트 앞부분(열린 문서는 버퍼)·이미지(ImageView)·이진은 HexView·
// 크기 초과는 안내. columns 스타일의 셋째 열과 details·icons 스타일의 미리보기 창이 공유한다
const props = defineProps<{ entry: DirEntry | null }>();
const emit = defineEmits<{ open: [entry: DirEntry] }>();

/** 텍스트 미리보기 읽기 상한 — 넘으면 크기 안내 (편집기 상한과 별개, 미리보기는 앞부분이면 족하다) */
const PREVIEW_MAX = 256 * 1024;
/** 텍스트 미리보기 줄 수 상한 */
const PREVIEW_LINES = 400;

type Preview =
  | { kind: 'loading' }
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'image'; data: string }
  | { kind: 'hex' }
  | { kind: 'unopenable'; reason: Unopenable }
  | { kind: 'error'; message: string };
const preview = ref<Preview | null>(null);
let seq = 0;
watch(
  () => (props.entry?.kind === 'file' ? props.entry.path : null),
  async (path) => {
    const mine = ++seq;
    if (path === null) {
      preview.value = null;
      return;
    }
    const doc = editors.docs.get(path);
    if (doc?.image !== undefined) {
      preview.value = { kind: 'image', data: doc.image };
      return;
    }
    if (doc && !doc.unopenable) {
      preview.value = clip(doc.content);
      return;
    }
    preview.value = { kind: 'loading' };
    try {
      const image = imageMime(path) !== null;
      const r = await backend.readFile(path, image ? { encoding: 'base64' } : { maxBytes: PREVIEW_MAX });
      if (mine !== seq) return;
      if (r.unopenable) preview.value = r.unopenable.kind === 'binary' ? { kind: 'hex' } : { kind: 'unopenable', reason: r.unopenable };
      else preview.value = image ? { kind: 'image', data: r.content } : clip(r.content);
    } catch (e) {
      if (mine === seq) preview.value = { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  },
  { immediate: true },
);
function clip(content: string): Preview {
  const lines = content.split('\n');
  return lines.length > PREVIEW_LINES
    ? { kind: 'text', text: lines.slice(0, PREVIEW_LINES).join('\n'), truncated: true }
    : { kind: 'text', text: content, truncated: false };
}
function fmtMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}
</script>

<template>
  <div class="folder-preview">
    <FolderColumn
      v-if="entry?.kind === 'directory'"
      :listing="files.listing.get(entry.path)"
      @click="(e) => emit('open', e)"
      @dblclick="(e) => emit('open', e)"
      @contextmenu="() => {}"
    />
    <template v-else-if="entry && preview">
      <div v-if="preview.kind === 'loading'" class="notice">
        <span class="codicon codicon-loading codicon-modifier-spin loading" /> Loading…
      </div>
      <pre v-else-if="preview.kind === 'text'" class="text">{{ preview.text }}<span v-if="preview.truncated" class="more">
… ({{ PREVIEW_LINES }} lines shown)</span></pre>
      <ImageView v-else-if="preview.kind === 'image'" :path="entry.path" :data="preview.data" />
      <HexView v-else-if="preview.kind === 'hex'" :key="entry.path" :path="entry.path" />
      <div v-else-if="preview.kind === 'unopenable'" class="notice">
        Too large to preview<template v-if="preview.reason.kind === 'large'"> ({{ fmtMB(preview.reason.size) }})</template>
      </div>
      <div v-else class="notice error">{{ preview.message }}</div>
    </template>
    <div v-else class="notice">No preview</div>
  </div>
</template>

<style scoped>
.folder-preview {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.text {
  flex: 1;
  margin: 0;
  padding: 4px 8px;
  overflow: auto;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
  line-height: 18px;
  color: var(--vscode-editor-foreground);
  white-space: pre;
  tab-size: 4;
}
.more {
  color: var(--vscode-descriptionForeground);
}
.notice {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 13px;
  color: var(--vscode-descriptionForeground);
}
.notice.error {
  color: var(--vscode-errorForeground);
}
</style>
