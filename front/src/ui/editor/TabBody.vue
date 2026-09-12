<script setup lang="ts">
import { computed } from 'vue';
import type { Doc, TabHolder } from '../../model/editors';
import { editors, openHex } from '../../model/editors';
import { sessionsKind } from '../../model/sessions';
import { canOpenExternally, downloadEntry, openExternally } from '../../model/transfer';
import MonacoHost from './MonacoHost.vue';
import UrlView from './UrlView.vue';
import ImageView from './ImageView.vue';
import HexView from './HexView.vue';
import HtmlPreview from './HtmlPreview.vue';
import TerminalView from './TerminalView.vue';
import FolderView from './FolderView.vue';
import SettingsView from './SettingsView.vue';
import DownloadsView from './DownloadsView.vue';
import { fmtMB } from './folderFmt';

// 탭 목록(그룹 또는 덱)의 활성 탭 본문 — EditorGroupView 에서 뽑아낸 것 (ticket terminal-tab-panes). 그룹은 자기
// 탭 목록을, DeckView 는 덱(카드 목록)을 holder 로 준다. active 는 이 목록이 포커스·커서를 소유하는가 —
// 그룹이면 활성 그룹, 덱이면 활성 그룹의 활성 탭이 그 덱 (MonacoHost·TerminalView 가 이 값으로 포커스를 받는다)
const props = defineProps<{ holder: TabHolder; groupId: number; active: boolean }>();
const emit = defineEmits<{ focus: [] }>();

const activeTab = computed(() => props.holder.tabs.find((t) => t.id === props.holder.activeTabId) ?? null);

/** 활성 탭이 monaco 대신 편집기 자리에 띄우는 것 — 우선순위는 탭 종류(hex·preview — 문서 상태와 무관한 전용 뷰)
 *  > 이미지 데이터 > 열 수 없음 사유이고, null 이면 monaco. diff 탭도 같은 문서라 이미지·안내가 동일하다 (이미지 diff
 *  는 범위 밖). 종류가 늘면 여기 분기 하나와 템플릿 분기 하나 — monaco 가림(v-show="!overlay")은 자동. 덱은 여기
 *  오지 않는다 (EditorGroupView 가 DeckView 로 보낸다) */
type Overlay =
  | { kind: 'hex' | 'preview'; path: string }
  | { kind: 'terminal'; term: number }
  | { kind: 'url' }
  | { kind: 'settings' }
  | { kind: 'downloads' }
  | { kind: 'folder'; tabId: string; path: string }
  | { kind: 'image'; path: string; data: string }
  | { kind: 'unopenable'; reason: NonNullable<Doc['unopenable']> }
  | { kind: 'loading' };
const overlay = computed<Overlay | null>(() => {
  const t = activeTab.value;
  if (!t) return null;
  if (t.kind === 'hex' || t.kind === 'preview') return { kind: t.kind, path: t.path };
  if (t.kind === 'terminal') return { kind: 'terminal', term: t.term };
  if (t.kind === 'url') return { kind: 'url' }; // 뷰는 아래 v-show 목록이 그린다 — 여기서는 monaco 가림만
  if (t.kind === 'settings') return { kind: 'settings' };
  if (t.kind === 'downloads') return { kind: 'downloads' };
  if (t.kind === 'folder') return { kind: 'folder', tabId: t.id, path: t.path };
  const doc = editors.docs.get(t.path);
  // 문서가 아직 안 읽힌 파일 탭(openFile 이 탭을 먼저 띄운다) — 빈 본문으로 이전 탭의 모델을 가린다
  if (t.kind === 'file' && doc === undefined) return { kind: 'loading' };
  if (doc?.image !== undefined) return { kind: 'image', path: t.path, data: doc.image };
  if (doc?.unopenable) return { kind: 'unopenable', reason: doc.unopenable };
  return null;
});
</script>

<template>
  <!-- 단일 루트 — 부모(EditorGroupView)가 v-show 로 덱과 바꿔 보이므로 fragment 면 안 된다 -->
  <div class="tab-body">
  <!-- URL 탭은 목록의 모든 URL 탭을 마운트한 채 v-show 로 활성 것만 보인다 — v-if 로 갈아 끼우면 탭을 오갈 때마다
       iframe 이 파괴되어 페이지를 처음부터 다시 로드한다 (browser-tab-iframe) -->
  <template v-for="t in holder.tabs" :key="t.id">
    <UrlView v-if="t.kind === 'url'" v-show="t.id === holder.activeTabId" :group-id="groupId" :tab-id="t.id" :url="t.url" @focus="emit('focus')" />
  </template>
  <!-- overlay 종류별 뷰 (hex·preview 는 path 키라 탭 전환 시 컴포넌트가 갈린다) -->
  <HexView v-if="overlay?.kind === 'hex'" :key="overlay.path" :path="overlay.path" />
  <HtmlPreview v-else-if="overlay?.kind === 'preview'" :key="overlay.path" :path="overlay.path" @focus="emit('focus')" />
  <TerminalView v-else-if="overlay?.kind === 'terminal'" :key="overlay.term" :term="overlay.term" :active="active" />
  <!-- 폴더 탭 — 탭 안 이동은 id 가 바뀌므로 key 를 두지 않는다 (같은 인스턴스가 path 변화를 따라간다) -->
  <FolderView v-else-if="overlay?.kind === 'folder'" :group-id="groupId" :tab-id="overlay.tabId" :path="overlay.path" />
  <SettingsView v-else-if="overlay?.kind === 'settings'" />
  <DownloadsView v-else-if="overlay?.kind === 'downloads'" />
  <ImageView v-else-if="overlay?.kind === 'image'" :path="overlay.path" :data="overlay.data" />
  <div v-else-if="overlay?.kind === 'loading'" class="loading" />
  <!-- 열 수 없는 파일(크기 초과·이진) 안내 -->
  <div v-else-if="overlay?.kind === 'unopenable'" class="unopenable">
    <p v-if="overlay.reason.kind === 'large'">
      The file is not displayed in the text editor because it is too large
      ({{ fmtMB(overlay.reason.size) }}).
    </p>
    <p v-else>
      The file is not displayed in the text editor because it is either binary or
      uses an unsupported text encoding.
    </p>
    <!-- hex 뷰어는 청크 읽기라 크기 상한이 없다 — 두 사유 모두 진입점 -->
    <a class="unopenable-link" @click="activeTab && openHex(activeTab.path)">Open in Hex Editor</a>
    <!-- 허용 확장자(Office 계열)만 — 앱은 임시 사본을 OS 기본 앱으로, 웹은 브라우저가 외부 앱을
         못 여니 같은 자리에 Download (ticket open-externally) -->
    <template v-if="activeTab && canOpenExternally(activeTab.path)">
      <a v-if="sessionsKind() === 'app'" class="unopenable-link" @click="openExternally(activeTab.path)">Open Externally</a>
      <a v-else class="unopenable-link" @click="downloadEntry(activeTab.path, 'file')">Download</a>
    </template>
  </div>
  <MonacoHost v-if="holder.tabs.length" v-show="!overlay" :holder="holder" :active="active" />
  </div>
</template>

<style scoped>
.tab-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.loading {
  flex: 1;
}
/* VS Code binary/large 안내 근사 — 중앙 정렬 텍스트 한 줄 */
.unopenable-link {
  display: block;
  margin-top: 8px;
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
}
.unopenable-link:hover {
  text-decoration: underline;
}
.unopenable {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 20px;
  text-align: center;
  color: var(--vscode-editor-foreground);
  font-size: 13px;
}
</style>
