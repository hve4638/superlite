<script setup lang="ts">
// 인라인 이름 입력 (VS Code explorer InputBox 근사; 탐색기 트리와 폴더 탭 FolderView 가 쓴다) — 실시간 검증, Enter 커밋/
// Esc 취소/blur 는 유효하면 커밋. 검증 에러는 입력 아래 붉은 박스 (VS Code 동일).
import { computed, onMounted, ref, watch } from 'vue';

const props = defineProps<{
  initial: string;
  /** true 면 확장자를 제외한 이름 부분만 선선택 (rename 의 VS Code 동작) */
  selectStem?: boolean;
  validate: (value: string) => string | null;
  /** 백엔드 거부 등 바깥에서 주입되는 에러 — 입력이 바뀌면 소비자가 지운다 */
  externalError?: string | null;
}>();
const emit = defineEmits<{ commit: [value: string]; cancel: []; input: [value: string] }>();

const el = ref<HTMLInputElement | null>(null);
const value = ref(props.initial);
/** 빈 값 에러는 커밋을 시도한 뒤부터만 보여준다 — 열리자마자 붉은 박스가 뜨지 않게 */
const touched = ref(false);
const error = computed(() => {
  const e = props.validate(value.value);
  if (e && (value.value !== '' || touched.value)) return e;
  return props.externalError ?? null;
});
let done = false; // Enter 커밋 직후 blur 가 이중 커밋하지 않게

// 커밋이 백엔드에서 거부되면(externalError 주입) 입력을 되살린다 — 래치가 남으면
// Enter 재시도·blur 취소가 전부 죽어 정정 기회라는 전제가 무너진다
watch(() => props.externalError, (e) => {
  if (e != null) done = false;
});

function commit(): void {
  touched.value = true;
  if (props.validate(value.value) !== null || done) return;
  done = true;
  emit('commit', value.value.trim());
}

function onKeydown(e: KeyboardEvent): void {
  e.stopPropagation(); // 트리의 F2/Delete/Ctrl+Z 핸들러로 새지 않게
  if (e.key === 'Enter') commit();
  else if (e.key === 'Escape') {
    done = true;
    emit('cancel');
  }
}

function onBlur(): void {
  if (done) return;
  // VS Code: blur 는 유효하면 커밋, 아니면 취소
  if (value.value.trim() !== '' && props.validate(value.value) === null) commit();
  else {
    done = true;
    emit('cancel');
  }
}

onMounted(() => {
  const input = el.value;
  if (!input) return;
  input.focus();
  const dot = props.selectStem ? props.initial.lastIndexOf('.') : -1;
  input.setSelectionRange(0, dot > 0 ? dot : props.initial.length);
});
</script>

<template>
  <div class="inline-name">
    <input
      ref="el"
      v-model="value"
      class="name-input"
      :class="{ invalid: error !== null }"
      spellcheck="false"
      autocomplete="off"
      @keydown="onKeydown"
      @blur="onBlur"
      @input="emit('input', value)"
    />
    <div v-if="error !== null" class="name-error">{{ error }}</div>
  </div>
</template>

<style scoped>
.inline-name {
  position: relative;
  flex: 1;
  min-width: 0;
  margin-right: 8px;
}
.name-input {
  width: 100%;
  box-sizing: border-box;
  height: 20px;
  padding: 0 4px;
  border: 1px solid var(--vscode-focusBorder);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font-size: 13px;
  font-family: inherit;
  outline: none;
}
.name-input.invalid {
  border-color: var(--vscode-inputValidation-errorBorder);
}
.name-error {
  position: absolute;
  left: 0;
  right: 0;
  top: 100%;
  z-index: 10;
  padding: 3px 5px;
  font-size: 12px;
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  color: var(--vscode-input-foreground);
}
</style>
