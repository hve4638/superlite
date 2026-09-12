<script setup lang="ts">
// 사용자 설정 폼 탭 (ticket user-settings) — model/settings 의 원장을 폼으로 편집한다. 항목이 바뀌면(change)
// 즉시 저장 (VS Code 설정 UI 와 같이 저장 버튼 없음). 원문 편집은 "Open Settings (JSON)" 탭.
import { computed } from 'vue';
import { LANGUAGES } from '../../model/languages';
import { saveSettings, settings, settingsEnabled, type RestoreWindows } from '../../model/settings';
import { openSettingsJson } from '../../model/configfiles';
import { inApp } from '../../model/window';

const enabled = settingsEnabled();

function setRestore(e: Event): void {
  settings.restoreWindows = (e.target as HTMLSelectElement).value as RestoreWindows;
  void saveSettings();
}

/** 줄 목록 ↔ textarea 본문 */
const internalText = computed(() => settings.urlOpen.internal.join('\n'));
const externalText = computed(() => settings.urlOpen.external.join('\n'));
function setList(key: 'internal' | 'external', e: Event): void {
  settings.urlOpen[key] = (e.target as HTMLTextAreaElement).value.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  void saveSettings();
}

// 언어 목록 — 레지스트리 전부 + plaintext (레지스트리 밖 기본값)
const languages = [...LANGUAGES.map((d) => ({ id: d.id, label: d.label })), { id: 'plaintext', label: 'Plain Text' }];
function setWrap(id: string, e: Event): void {
  const on = (e.target as HTMLInputElement).checked;
  if (on) settings.wordWrap[id] = true;
  else delete settings.wordWrap[id];
  void saveSettings();
}
</script>

<template>
  <div class="settings-view">
    <div class="head">
      <h1>Settings</h1>
      <a class="link" @click="openSettingsJson()">Open Settings (JSON)</a>
    </div>
    <p v-if="!enabled" class="warn">Settings cannot be saved in this window (no backend). Changes below apply until reload only.</p>

    <section>
      <h2>URL: Open Links</h2>
      <p class="desc">
        Where a link opens (terminal Ctrl+click): an internal URL tab or the external browser. One host per line;
        <code>google.com</code> also matches its subdomains, ports are ignored. <code>[IP]</code> matches any IP address,
        <code>[DOMAIN]</code> any domain name, <code>*</code> anything. When both lists match, the more specific line wins
        (exact host › subdomain › [IP]/[DOMAIN] › *), ties go to internal. Unlisted hosts open externally.
      </p>
      <div class="lists">
        <label>
          <span>Open internally (URL tab)</span>
          <textarea :value="internalText" spellcheck="false" rows="6" placeholder="localhost&#10;[IP]" @change="setList('internal', $event)" />
        </label>
        <label>
          <span>Open externally (browser)</span>
          <textarea :value="externalText" spellcheck="false" rows="6" placeholder="naver.com&#10;*" @change="setList('external', $event)" />
        </label>
      </div>
    </section>

    <section>
      <h2>Window: Restore Windows</h2>
      <p class="desc">
        After an abnormal exit (shutdown, killed process, update install) reopen the windows that were open, with all
        their session tabs. Closing a window with × is a normal exit and nothing is restored.
        <template v-if="!inApp">Applies to the desktop app only.</template>
      </p>
      <select class="select" :value="settings.restoreWindows" @change="setRestore($event)">
        <option value="none">none — always start with an empty session</option>
        <option value="one">one — the last focused window</option>
        <option value="all">all — every window</option>
      </select>
    </section>

    <section>
      <h2>Editor: Word Wrap</h2>
      <p class="desc">Default word wrap for new editor tabs, by language. Alt+Z still toggles the current tab only.</p>
      <div class="langs">
        <label v-for="l in languages" :key="l.id">
          <input type="checkbox" :checked="settings.wordWrap[l.id] === true" @change="setWrap(l.id, $event)">
          <span>{{ l.label }}</span>
        </label>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings-view {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px 32px 48px;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  user-select: text;
}
.head {
  display: flex;
  align-items: baseline;
  gap: 16px;
  max-width: 800px;
}
h1 {
  font-size: 20px;
  font-weight: 600;
  margin: 8px 0 12px;
}
h2 {
  font-size: 14px;
  font-weight: 600;
  margin: 24px 0 6px;
}
.link {
  cursor: pointer;
  color: var(--vscode-textLink-foreground);
}
.link:hover {
  text-decoration: underline;
}
.warn {
  color: var(--vscode-errorForeground, #f48771);
}
.desc {
  max-width: 800px;
  margin: 0 0 10px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.5;
}
code {
  font-family: var(--vscode-editor-font-family, monospace);
  background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.2));
  padding: 0 3px;
  border-radius: 2px;
}
.lists {
  display: flex;
  gap: 16px;
  max-width: 800px;
}
.lists label {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
textarea {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 13px;
  padding: 4px 6px;
  border: 1px solid var(--vscode-input-border);
  border-radius: 2px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  resize: vertical;
  outline: none;
}
textarea:focus {
  border-color: var(--vscode-focusBorder);
}
.select {
  font: inherit;
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--vscode-input-border);
  border-radius: 2px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  outline: none;
}
.select:focus {
  border-color: var(--vscode-focusBorder);
}
.langs {
  display: grid;
  grid-template-columns: repeat(auto-fill, 180px);
  gap: 4px 12px;
  max-width: 800px;
}
.langs label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
</style>
