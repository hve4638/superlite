/**
 * 파일 조작(생성·이름변경·삭제) + 파일 한정 undo — VS Code bulk-edit 역연산의 최소판.
 * 성공 즉시 가까운 로드된 조상을 refreshDir — 자기 조작은 감시 이벤트를 기다리지 않는다
 * (VS Code 의 onDidRunOperation 즉시 반영과 동일. 뒤따라오는 fsChanges 는 중복 리프레시일 뿐).
 */
import type { ThinBackend } from '../backend/types';
import { ctx } from './ctx';
import { baseName, type createEditors } from './editors';
import { type createFiles, parentOf } from './files';
import { errText, notify } from './notifications';
import type { createScm } from './scm';

/** undo-of-delete 의 내용 캡처 상한 (VS Code 동일 5MB) — 넘으면 undo 없는 삭제 */
const UNDO_CAPTURE_MAX = 5 * 1024 * 1024;

const swallow = (p: Promise<unknown>): void => void p.catch(() => {});

/** clipboard_ 파일명의 타임스탬프 — 참고 구현(save-clipboard)의 yyyyMMdd_HHmmss_fff */
function timestampName(): string {
  const d = new Date();
  const n = (v: number, w = 2): string => String(v).padStart(w, '0');
  return `${d.getFullYear()}${n(d.getMonth() + 1)}${n(d.getDate())}_${n(d.getHours())}${n(d.getMinutes())}${n(d.getSeconds())}_${n(d.getMilliseconds(), 3)}`;
}

/** MIME 서브타입 → 확장자. 클립보드 이미지는 사실상 항상 image/png 다 — jpeg 만 관례로 축약 */
const extOf = (mime: string): string => mime.replace(/^image\//, '').replace('jpeg', 'jpg');

/** Blob → base64 (data URL 의 페이로드 부분) — writeFile 의 base64 와이어용 (업로드 청크도 같은 통로) */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).slice((r.result as string).indexOf(',') + 1));
    r.onerror = () => reject(r.error ?? new Error('failed to read blob'));
    r.readAsDataURL(blob);
  });
}

/** 세션별 파일 조작 모듈 — undo 스택이 세션에 묶인다 */
export function createFileops(
  backend: ThinBackend,
  editorsM: ReturnType<typeof createEditors>,
  filesM: ReturnType<typeof createFiles>,
  scmM: ReturnType<typeof createScm>,
) {
  const { closePathTabs, remapPaths } = editorsM;
  const { loadedDirPaths, invalidateQuickOpen, refreshDir } = filesM;
  const { refreshScm } = scmM;

  /** 중첩 생성(a/b/c.ts)의 부모는 미로드일 수 있다 — 리프레시는 로드된 조상에서 시작해야 보인다 */
  function nearestLoaded(dir: string): string {
    const loaded = new Set(loadedDirPaths());
    let d = dir;
    while (d !== '' && !loaded.has(d)) d = parentOf(d);
    return d;
  }

  // ponytail: 디렉토리 rename 시 하위 펼침 상태는 잃는다 — 새 경로 노드는 새로 로드된다
  async function refreshAfter(paths: string[]): Promise<void> {
    const dirs = [...new Set(paths.map((p) => nearestLoaded(parentOf(p))))];
    await Promise.all(dirs.map((d) => refreshDir(d)));
    invalidateQuickOpen();
    swallow(refreshScm());
  }

  /** ponytail: 스택 하나, redo 없음, 폴더 삭제는 미등록 — VS Code 파일 조작 undo 의 최소판 */
  const undoStack: Array<() => Promise<void>> = [];

  // raw* 는 undo 를 쌓지 않는다 — undo 실행이 다시 undo 를 쌓으면 Ctrl+Z 가 스택을
  // 내려가는 대신 마지막 조작만 핑퐁한다
  async function rawDelete(path: string): Promise<void> {
    await backend.delete(path);
    closePathTabs(path);
    await refreshAfter([path]);
  }

  async function rawRename(from: string, to: string): Promise<void> {
    await backend.rename(from, to);
    remapPaths(from, to);
    await refreshAfter([from, to]);
  }

  async function createFile(path: string): Promise<void> {
    await backend.createFile(path);
    undoStack.push(() => rawDelete(path));
    await refreshAfter([path]);
  }

  async function createDir(path: string): Promise<void> {
    await backend.createDir(path);
    undoStack.push(() => rawDelete(path));
    await refreshAfter([path]);
  }

  /**
   * 클립보드 이미지를 dir 에 파일로 저장 (탐색기 붙여넣기). 저장된 경로 반환, 실패는
   * notify 후 null. 파일명은 참고 구현(save-clipboard)의 clipboard_<타임스탬프> 규칙 —
   * 밀리초 단위라 충돌은 사실상 없어 중복 검사를 두지 않는다.
   */
  async function saveClipboardImage(dir: string, blob: Blob): Promise<string | null> {
    const name = `clipboard_${timestampName()}.${extOf(blob.type)}`;
    const path = dir === '' ? name : `${dir}/${name}`;
    try {
      await backend.writeFile(path, await blobToBase64(blob), undefined, 'base64');
    } catch (e) {
      notify('error', `Failed to save clipboard image: ${errText(e)}`);
      return null;
    }
    undoStack.push(() => rawDelete(path));
    await refreshAfter([path]);
    return path;
  }

  async function renameEntry(from: string, to: string): Promise<void> {
    await rawRename(from, to);
    undoStack.push(() => rawRename(to, from));
  }

  /** 복사 (와이어 v19, 디렉토리 재귀). undo = 사본 삭제 */
  async function copyEntry(from: string, to: string): Promise<void> {
    await backend.copy(from, to);
    undoStack.push(() => rawDelete(to));
    await refreshAfter([to]);
  }

  /**
   * 탐색기 드래그 이동·복사 — paths 를 dir 안으로 같은 이름으로 (ticket explorer-multiselect-dnd). 순차
   * 실행이라 undo 는 항목별로 쌓인다 (한 번의 Ctrl+Z 가 한 항목씩 되돌린다 — VS Code 의 묶음 undo 와
   * 다르다, redo 없음). dir 에 같은 이름이 있으면 confirmReplace(name) 로 항목마다 묻고(false = 그 항목
   * 건너뜀), 승인이면 기존 것을 지운 뒤 진행 (rename·copy 는 대상 존재를 거부하므로 덮어쓰기는 여기서
   * 명시 — 그 rawDelete 는 내용을 캡처하지 않으므로 Ctrl+Z 는 옮겨 온 항목만 되돌리고 대체당한 원본은
   * 복구하지 못한다). 실패한 항목은 notify 하고 다음으로. 자기 자신·자기 하위로의 이동 차단은 호출측(드롭 판정) 몫.
   * 반환은 새 경로들 — 호출측이 선택을 옮긴다
   */
  async function transferEntries(
    paths: string[],
    dir: string,
    mode: 'move' | 'copy',
    confirmReplace: (name: string) => Promise<boolean>,
  ): Promise<string[]> {
    let existing: Set<string>;
    try {
      existing = new Set((await backend.readDir(dir)).map((e) => e.name));
    } catch (e) {
      notify('error', `Failed to read destination folder: ${errText(e)}`);
      return [];
    }
    const out: string[] = [];
    for (const from of paths) {
      const name = baseName(from);
      const to = dir === '' ? name : `${dir}/${name}`;
      if (to === from) continue;
      try {
        if (existing.has(name)) {
          if (!(await confirmReplace(name))) continue;
          await rawDelete(to);
        }
        if (mode === 'move') await renameEntry(from, to);
        else await copyEntry(from, to);
        out.push(to);
      } catch (e) {
        notify('error', `Failed to ${mode} '${name}': ${errText(e)}`);
      }
    }
    return out;
  }

  async function deleteEntry(path: string, kind: 'file' | 'directory'): Promise<void> {
    // 삭제 전에 내용을 캡처해야 undo 로 되살릴 수 있다 — 바이너리(read 실패)·대용량·폴더는
    // 캡처 없이 지우고 undo 미등록 (VS Code 동일: 폴더·5MB 초과는 undo 불가)
    let captured: string | null = null;
    if (kind === 'file') {
      try {
        // maxBytes: 상한 초과 파일을 읽어 나른 뒤 버리는 낭비 방지 — 백엔드가 stat 로 거른다.
        // 대용량·바이너리는 unopenable 로 온다 — 캡처(undo)만 포기하고 삭제는 진행한다
        const r = await backend.readFile(path, { maxBytes: UNDO_CAPTURE_MAX });
        if (r.content !== undefined) captured = r.content;
      } catch {
        /* 캡처 실패(읽기 에러) — undo 만 포기 */
      }
    }
    // try 는 delete RPC 만 감싼다 — 성공한 삭제의 후처리(리프레시) 실패가
    // "Failed to delete" 로 위장하고 undo 등록까지 건너뛰면 안 된다
    try {
      await backend.delete(path);
    } catch (e) {
      notify('error', `Failed to delete '${baseName(path)}': ${errText(e)}`);
      return;
    }
    closePathTabs(path);
    await refreshAfter([path]);
    if (captured !== null) {
      const content = captured;
      undoStack.push(async () => {
        // WHY: 스택에 쌓인 사이 외부가 같은 경로를 만들었을 수 있다 — 일치할 리 없는 etag 를
        //      제시하면 데몬 검사가 "없으면 생성(부활), 있으면 conflict 로 미기록" 이 된다
        const r = await backend.writeFile(path, content, '0-0');
        if (r.conflict) {
          notify('warning', `Undo skipped: a file already exists at '${baseName(path)}'`);
          return;
        }
        await refreshAfter([path]);
      });
    }
  }

  /** 마지막 파일 조작 역연산 (탐색기 포커스 Ctrl+Z). 실패하면 해당 항목은 버려진다. */
  async function undoFileOp(): Promise<void> {
    const undo = undoStack.pop();
    if (!undo) return;
    try {
      await undo();
    } catch (e) {
      notify('error', `Failed to undo: ${errText(e)}`);
    }
  }

  return { createFile, createDir, saveClipboardImage, renameEntry, transferEntries, deleteEntry, undoFileOp };
}

// ---- 활성 세션 전달 shim

export const createFile = (path: string): Promise<void> => ctx().fileops.createFile(path);
export const createDir = (path: string): Promise<void> => ctx().fileops.createDir(path);
export const saveClipboardImage = (dir: string, blob: Blob): Promise<string | null> =>
  ctx().fileops.saveClipboardImage(dir, blob);
export const renameEntry = (from: string, to: string): Promise<void> =>
  ctx().fileops.renameEntry(from, to);
export const transferEntries = (
  paths: string[], dir: string, mode: 'move' | 'copy', confirmReplace: (name: string) => Promise<boolean>,
): Promise<string[]> => ctx().fileops.transferEntries(paths, dir, mode, confirmReplace);
export const deleteEntry = (path: string, kind: 'file' | 'directory'): Promise<void> =>
  ctx().fileops.deleteEntry(path, kind);
export const undoFileOp = (): Promise<void> => ctx().fileops.undoFileOp();
