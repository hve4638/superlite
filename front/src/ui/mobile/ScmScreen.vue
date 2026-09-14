<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { activeRepo, CHANGE_COLOR, CHANGE_LETTER, commit, refreshScm, scm, selectRepo, stage, unstage, type ScmChange } from '../../model/scm';
import FileIcon from '../widgets/FileIcon.vue';
import { openDiff, openFile } from '../../model/editors';
import { goTo } from './nav';
import FullscreenButton from './FullscreenButton.vue';

// SCM 탭 (ticket mobile-shell) — 선택 저장소의 Staged / Changes 두 목록, 행의 +/− 로 stage·unstage, 커밋 메시지 + Commit
// (데스크톱과 같이 staged 만 커밋 — model/scm.commit). discard·브랜치·동기화는 범위 밖
onMounted(() => void refreshScm());
const repo = computed(() => activeRepo());
const staged = computed(() => repo.value?.changes.filter((c) => c.staged) ?? []);
const unstaged = computed(() => repo.value?.changes.filter((c) => !c.staged) ?? []);
const canCommit = computed(() => !!repo.value && staged.value.length > 0 && repo.value.commitMessage.trim() !== '');
// 행 탭 = 편집기 영역에 diff 탭(model/editors.openDiff — 데스크톱과 같은 탭)을 열고 Editor 탭으로. untracked·added 는 파일 탭
async function open(c: ScmChange): Promise<void> {
  if (c.kind === 'untracked' || c.kind === 'added') {
    if (!(await openFile(c.path, { focus: false }))) return;
  } else await openDiff(c.path, { deleted: c.kind === 'deleted' });
  goTo('editor');
}
</script>

<template>
  <div class="m-screen">
    <header class="m-header">
      <span class="codicon codicon-source-control" />
      <select v-if="scm.repos.length > 1" class="repo" :value="repo?.path ?? ''" @change="selectRepo(($event.target as HTMLSelectElement).value)">
        <option v-for="r in scm.repos" :key="r.path" :value="r.path">{{ r.path || 'root' }}</option>
      </select>
      <span class="title">{{ repo?.branch || 'no repository' }}</span>
      <button class="m-icon-btn" title="Refresh" @click="refreshScm()"><span class="codicon codicon-refresh" /></button>
      <FullscreenButton />
    </header>
    <div v-if="!repo" class="m-empty">No git repository</div>
    <template v-else>
      <div class="commit">
        <textarea v-model="repo.commitMessage" rows="2" placeholder="Commit message" />
        <button class="m-primary" :disabled="!canCommit" @click="commit(repo!)">Commit</button>
      </div>
      <div class="m-list">
        <div class="m-section row"><span>Staged ({{ staged.length }})</span><button v-if="staged.length" @click="unstage(staged)">Unstage all</button></div>
        <div v-for="c in staged" :key="`s:${c.path}`" class="m-row" :style="{ color: `var(${CHANGE_COLOR[c.kind]})` }" @click="open(c)">
          <FileIcon :name="c.name" />
          <div class="main"><div class="name">{{ c.name }}</div><div class="meta">{{ c.dir }}</div></div>
          <span class="letter">{{ CHANGE_LETTER[c.kind] }}</span>
          <button class="m-icon-btn" @click.stop="unstage([c])"><span class="codicon codicon-remove" /></button>
        </div>
        <div class="m-section row"><span>Changes ({{ unstaged.length }})</span><button v-if="unstaged.length" @click="stage(unstaged)">Stage all</button></div>
        <div v-for="c in unstaged" :key="`u:${c.path}`" class="m-row" :style="{ color: `var(${CHANGE_COLOR[c.kind]})` }" @click="open(c)">
          <FileIcon :name="c.name" />
          <div class="main"><div class="name">{{ c.name }}</div><div class="meta">{{ c.dir }}</div></div>
          <span class="letter">{{ CHANGE_LETTER[c.kind] }}</span>
          <button class="m-icon-btn" @click.stop="stage([c])"><span class="codicon codicon-add" /></button>
        </div>
        <div v-if="repo.changes.length === 0" class="m-empty">No changes</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.repo {
  font: inherit;
  color: inherit;
  background: var(--vscode-input-background, #313131);
  border: 1px solid var(--vscode-input-border, #3c3c3c);
  border-radius: 4px;
  padding: 6px;
  max-width: 40%;
}
.commit {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-widget-border, #2b2b2b);
}
.commit textarea {
  flex: 1;
  font: inherit;
  font-size: 14px;
  color: inherit;
  background: var(--vscode-input-background, #313131);
  border: 1px solid var(--vscode-input-border, #3c3c3c);
  border-radius: 4px;
  padding: 8px;
  resize: none;
  user-select: text;
}
.m-section.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.m-section.row button {
  text-transform: none;
  letter-spacing: 0;
  font-weight: 400;
  font-size: 13px;
  color: var(--sl-accent, #3794ff);
}
.letter {
  font-size: 13px;
  font-weight: 600;
}
.m-row .m-icon-btn {
  color: var(--vscode-foreground);
}
</style>
