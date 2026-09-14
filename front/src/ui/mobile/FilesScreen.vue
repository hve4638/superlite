<script setup lang="ts">
import { computed } from 'vue';
import type { TreeNode } from '../../model/files';
import { files, toggleDir, visibleNodes } from '../../model/files';
import { openFile } from '../../model/editors';
import { decorationFor } from '../../model/scm';
import { workbench } from '../../model/workbench';
import FileIcon from '../widgets/FileIcon.vue';
import { goTo } from './nav';
import FullscreenButton from './FullscreenButton.vue';

// 파일 탭 (ticket mobile-shell) — 탐색기 트리(model/files, 데스크톱과 같은 펼침 상태). 데스크톱 사이드바 탐색기 역할:
// 폴더 = 펼침·접힘, 파일 = 편집기 영역(Editor 탭)에 열고 그리로 넘어간다 (이미 열려 있으면 그 탭 활성화 — model/editors.openFile).
// 열린 편집기 목록은 Editor 탭의 탭 줄이 맡는다. 새 파일·이름 바꾸기·삭제·드래그는 없다 (열람·가벼운 편집이 범위)
const rows = computed(() => visibleNodes());
async function tap(n: TreeNode): Promise<void> {
  if (n.kind === 'directory') {
    void toggleDir(n);
    return;
  }
  if (await openFile(n.path, { focus: false })) goTo('editor');
}
function deco(n: TreeNode): { letter: string; color: string } | null {
  return decorationFor(n.path, n.kind === 'directory');
}
</script>

<template>
  <div class="m-screen">
    <header class="m-header">
      <span class="codicon codicon-files" />
      <span class="title">{{ workbench.workspaceName || 'Files' }}</span>
      <FullscreenButton />
    </header>
    <div class="m-list">
      <div v-if="files.loading" class="m-empty">Loading…</div>
      <div
        v-for="n in rows"
        :key="n.path"
        class="m-row tree"
        :style="{ paddingLeft: `${12 + n.depth * 16}px`, color: deco(n) ? `var(${deco(n)!.color})` : undefined }"
        @click="tap(n)"
      >
        <span v-if="n.kind === 'directory'" class="codicon" :class="files.expanded.has(n.path) ? 'codicon-chevron-down' : 'codicon-chevron-right'" />
        <span v-else class="spacer" />
        <span v-if="n.kind === 'directory'" class="codicon codicon-folder" />
        <FileIcon v-else :name="n.name" />
        <div class="main"><div class="name">{{ n.name }}</div></div>
        <span v-if="deco(n)?.letter" class="letter">{{ deco(n)!.letter }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.m-row.tree {
  min-height: 42px;
  gap: 6px;
  border-bottom: 0;
}
.spacer {
  width: 16px;
  flex-shrink: 0;
}
.letter {
  font-size: 12px;
  opacity: 0.8;
}
</style>
