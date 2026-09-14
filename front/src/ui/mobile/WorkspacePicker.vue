<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { openFolder } from '../../model/host';
import { activeSessionCtx, sessions } from '../../model/sessions';
import { recentName, recents, refreshRecents } from '../../model/recents';
import { workbench } from '../../model/workbench';

// 워크스페이스 추가 (ticket mobile-shell, 사용자 결정 2026-09-15 개정 — 종전의 현재 세션 교체에서 세션 추가로) — Workspace 탭의 +.
// host.openFolder 기본 모드 → sessions.openWebFolder: 새 세션을 열어 활성으로 (이미 열린 root 면 그 세션으로 전환, 활성이 빈
// 세션이면 그 자리를 채운다). 화면: 최근 폴더(model/recents — 웹은 localStorage) + 디렉토리 탐색(backend.browseDir, 데스크톱
// 퀵인풋 folder 모드와 같은 나열, 현재 루트에서 시작)
const emit = defineEmits<{ close: [] }>();
const dir = ref(workbench.rootPath || '/');
const names = ref<string[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const current = computed(() => sessions.list.find((t) => t.id === sessions.activeId)?.root ?? null);
const recentRoots = computed(() => recents.recents.filter((r) => r.root !== current.value));
const baseName = (p: string) => p.split('/').filter((s) => s !== '').pop() ?? p;
const isRoot = computed(() => dir.value === '/');

async function list(): Promise<void> {
  const b = activeSessionCtx()?.backend;
  if (!b?.browseDir) {
    error.value = 'Folder browsing is not available';
    return;
  }
  loading.value = true;
  error.value = null;
  const d = dir.value;
  try {
    const out = await b.browseDir(d.endsWith('/') ? d : `${d}/`);
    if (dir.value === d) names.value = out;
  } catch (e) {
    if (dir.value === d) {
      names.value = [];
      error.value = String(e);
    }
  } finally {
    if (dir.value === d) loading.value = false;
  }
}
function enter(name: string): void {
  dir.value = isRoot.value ? `/${name}` : `${dir.value}/${name}`;
}
function up(): void {
  const i = dir.value.lastIndexOf('/');
  dir.value = i <= 0 ? '/' : dir.value.slice(0, i);
}
function open(root: string): void {
  openFolder(root);
  emit('close');
}
onMounted(() => void refreshRecents());
watch(dir, () => void list(), { immediate: true });
</script>

<template>
  <div class="m-screen">
    <header class="m-header">
      <button class="m-icon-btn" @click="emit('close')"><span class="codicon codicon-close" /></button>
      <span class="title">Add Workspace<br /><span class="sub">{{ dir }}</span></span>
      <button class="m-primary" :disabled="dir === current" @click="open(dir)">Open</button>
    </header>
    <div class="m-list">
      <template v-if="recentRoots.length > 0">
        <div class="m-section">Recent</div>
        <div v-for="r in recentRoots" :key="r.root" class="m-row" @click="open(r.root)">
          <span class="codicon codicon-history" />
          <div class="main"><div class="name">{{ recentName(r.root) }}</div><div class="meta">{{ r.root }}</div></div>
        </div>
      </template>
      <div class="m-section">{{ baseName(dir) || '/' }}</div>
      <div v-if="!isRoot" class="m-row" @click="up()">
        <span class="codicon codicon-arrow-up" />
        <div class="main"><div class="name">..</div></div>
      </div>
      <div v-if="loading" class="m-empty">Loading…</div>
      <div v-else-if="error" class="m-empty">{{ error }}</div>
      <div v-for="n in names" :key="n" class="m-row" @click="enter(n)">
        <span class="codicon codicon-folder" />
        <div class="main"><div class="name">{{ n }}</div></div>
        <span class="codicon codicon-chevron-right" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.m-header .title {
  line-height: 1.2;
  white-space: normal;
}
.m-header .m-primary {
  padding: 8px 14px;
  flex-shrink: 0;
}
</style>
