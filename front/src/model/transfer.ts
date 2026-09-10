/**
 * 원격 워크스페이스 ↔ 로컬 PC 파일 전송 (ticket explorer-download) — VS Code 원격 탐색기의
 * "Download..." 와 OS 드롭 업로드 파리티. 전용 와이어 메서드 없이 readFile 범위 읽기(v11)와
 * writeFile base64 + append(v14)로 4MB 조각 단위로 나른다 — 큰 파일도 한 메시지에 싣지 않는다.
 * 로컬 저장은 환경별 sink: 앱은 native 저장 dialog + 파일 쓰기(Tauri 커맨드 pick_save_target·
 * local_write·local_mkdir), 웹은 브라우저 Blob 다운로드(폴더는 트리 저장이 불가해 zip).
 * 업로드는 DOM File 내용을 읽으므로 앱·웹 공통 경로다.
 * ponytail: 전송은 한 번에 하나, 취소 없음, 진행은 상태바 항목 하나(transfer.active).
 * 폴더 다운로드는 readDir 기준이라 트리가 숨기는 항목(.git 등 files.exclude)은 빠진다.
 */
import { reactive } from '@vue/reactivity';
import type { ThinBackend } from '../backend/types';
import { ctx } from './ctx';
import { baseName, base64Bytes } from './editors';
import { blobToBase64 } from './fileops';
import { errText, notify, type NotifyAction } from './notifications';
import { sessionsKind } from './sessions';
import { tauri } from './tauri';
import { ZipWriter } from './zip';

/** 조각 크기 — relay 의 payload 상한(64MB)·JSON 한 줄 파싱 비용과 왕복 횟수의 절충 */
const CHUNK = 4 * 1024 * 1024;
/** 폴더 다운로드 재귀 깊이 상한 — readDir 은 심링크를 따라가므로 순환 심링크가 있으면 끝없이 내려간다 */
const MAX_DEPTH = 64;

/** 원격이 준 항목 이름이 로컬 경로 조각으로 안전한가 — 구분자·'..' 은 고른 저장 위치를 벗어난다.
 *  정상 데몬은 실제 디렉터리 항목명만 주지만, 로컬 쓰기 경로에 원격 데이터를 검사 없이 잇지 않는다 */
function checkName(name: string): string {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`unsafe entry name: '${name}'`);
  }
  return name;
}

export interface TransferProgress {
  label: string;
  done: number;
  total: number;
}

/** 진행 중인 전송 (없으면 null) — 상태바가 라벨·퍼센트를 그린다 */
export const transfer = reactive({ active: null as TransferProgress | null });

/** 전송 중이면 경고를 띄우고 true — run 과 uploadDropped(대화상자 전 선행 검사)가 같은 문구를 낸다 */
function rejectIfBusy(): boolean {
  if (!transfer.active) return false;
  notify('warning', `A transfer is already in progress: ${transfer.active.label}`);
  return true;
}

/** 전송 하나를 상태바에 걸고 실행 — 동시에 둘은 거절, 실패는 notify. 성공 여부 반환 */
async function run(label: string, body: (progress: (done: number, total: number) => void) => Promise<void>): Promise<boolean> {
  if (rejectIfBusy()) return false;
  transfer.active = { label, done: 0, total: 0 };
  try {
    await body((done, total) => {
      transfer.active = { label, done, total };
    });
    return true;
  } catch (e) {
    notify('error', `${label} failed: ${errText(e)}`);
    return false;
  } finally {
    transfer.active = null;
  }
}

// ---- 다운로드

/** 로컬 저장 대상 — rel 은 다운로드 루트 기준 상대 경로 ('' = 파일 다운로드의 그 파일) */
interface Sink {
  mkdir(rel: string): Promise<void>;
  /** base64 조각 — append 는 같은 rel 의 두 번째 조각부터 */
  write(rel: string, data: string, append: boolean): Promise<void>;
  /** 완료 통지 문구 (+ 선택 액션 — 앱의 "폴더 열기") */
  finish(): Promise<{ message: string; action?: NotifyAction }>;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 브라우저 저장 — a[download] 클릭. 브라우저의 다운로드 폴더로 간다 (저장 위치 선택 없음) */
function saveBlob(name: string, parts: Uint8Array[]): void {
  const url = URL.createObjectURL(new Blob(parts as BlobPart[]));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** 앱 — native dialog 로 위치를 고르고 조각마다 local_write. 취소면 null */
async function appSink(kind: 'file' | 'directory', name: string): Promise<Sink | null> {
  const t = tauri!;
  const target = (await t.core.invoke('pick_save_target', { kind, name })) as string | null;
  if (target === null) return null;
  const local = (rel: string): string => (rel === '' ? target : `${target}/${rel}`);
  return {
    mkdir: async (rel) => void (await t.core.invoke('local_mkdir', { path: local(rel) })),
    write: async (rel, data, append) => void (await t.core.invoke('local_write', { path: local(rel), data, append })),
    finish: async () => ({
      message: `Downloaded to ${target}`,
      // OS 파일 관리자로 저장 위치를 드러낸다 (파일은 선택 표시) — ticket download-conveniences
      action: {
        label: 'Open Folder',
        run: () => void t.core.invoke('reveal_in_folder', { path: target }).catch((e: unknown) => notify('error', `Open folder: ${errText(e)}`)),
      },
    }),
  };
}

/** 웹 파일 — 조각을 모아 Blob 하나로 */
function webFileSink(name: string): Sink {
  const parts: Uint8Array[] = [];
  return {
    mkdir: async () => {},
    write: async (_rel, data) => void parts.push(base64ToBytes(data)),
    finish: async () => {
      saveBlob(name, parts);
      return { message: `Downloaded ${name}` };
    },
  };
}

/** 웹 폴더 — zip 한 파일. 항목은 rel 순서대로 들어오고 같은 rel 의 조각은 연속한다 */
function webZipSink(name: string): Sink {
  const zip = new ZipWriter();
  return {
    mkdir: async (rel) => {
      if (rel !== '') {
        zip.begin(rel, true);
        zip.end();
      }
    },
    write: async (rel, data, append) => {
      if (!append) {
        zip.end();
        zip.begin(rel);
      }
      zip.append(base64ToBytes(data));
    },
    finish: async () => {
      saveBlob(`${name}.zip`, zip.finish());
      return { message: `Downloaded ${name}.zip` };
    },
  };
}

/** 원격 파일 하나를 sink 의 rel 로 — stat 크기만큼 범위 읽기. 빈 파일도 만든다 */
async function copyFile(
  backend: ThinBackend,
  path: string,
  rel: string,
  sink: Sink,
  onBytes?: (done: number, total: number) => void,
): Promise<void> {
  const { size } = await backend.stat(path);
  if (size === 0) {
    await sink.write(rel, '', false);
    return;
  }
  let off = 0;
  while (off < size) {
    const r = await backend.readFile(path, { encoding: 'base64', offset: off, maxBytes: CHUNK });
    if (r.content === undefined) throw new Error(`cannot read '${path}'`);
    const n = base64Bytes(r.content);
    if (n === 0) break; // 읽는 사이 줄어든 파일 — 받은 만큼에서 끝낸다
    await sink.write(rel, r.content, off > 0);
    off += n;
    onBytes?.(off, size);
  }
}

/** 원격 폴더를 재귀로 걷어 파일 목록(경로·rel)을 모으고, 만나는 폴더는 sink 에 바로 만든다 */
async function collectDir(backend: ThinBackend, dir: string, rel: string, sink: Sink, out: Array<{ path: string; rel: string }>, depth = 0): Promise<void> {
  if (depth > MAX_DEPTH) throw new Error(`folder too deep (symlink loop?): '${dir}'`);
  await sink.mkdir(rel);
  for (const e of await backend.readDir(dir)) {
    const r = rel === '' ? checkName(e.name) : `${rel}/${checkName(e.name)}`;
    if (e.kind === 'directory') await collectDir(backend, e.path, r, sink, out, depth + 1);
    else out.push({ path: e.path, rel: r });
  }
}

/**
 * 탐색기 "Download..." — 원격 파일·폴더를 로컬 PC 로. 파일은 저장 위치(앱)·다운로드 폴더(웹),
 * 폴더는 고른 폴더 안의 같은 이름 하위 폴더(앱)·<이름>.zip(웹). 진행: 파일은 바이트, 폴더는 파일 수
 */
export async function downloadEntry(path: string, kind: 'file' | 'directory'): Promise<void> {
  const backend = ctx().backend;
  const name = checkName(baseName(path));
  // as — 클로저 안 대입이라 초기값 null 로 좁혀지지 않게
  let done = null as { message: string; action?: NotifyAction } | null;
  // dialog 대기도 run 안 — 그 사이 두 번째 Download 가 dialog 를 하나 더 띄우지 않게
  const ok = await run(`Downloading ${name}`, async (progress) => {
    const sink =
      sessionsKind() === 'app' ? await appSink(kind, name) : kind === 'file' ? webFileSink(name) : webZipSink(name);
    if (!sink) return; // dialog 취소
    if (kind === 'file') {
      await copyFile(backend, path, '', sink, progress);
    } else {
      const list: Array<{ path: string; rel: string }> = [];
      await collectDir(backend, path, '', sink, list);
      for (let i = 0; i < list.length; i++) {
        progress(i, list.length);
        await copyFile(backend, list[i].path, list[i].rel, sink);
      }
    }
    done = await sink.finish();
  });
  if (ok && done !== null) notify('info', done.message, done.action);
}

// ---- 업로드

/** DataTransferItem.webkitGetAsEntry 결과(폴더 재귀 가능) — 드롭 이벤트 안에서 동기로 뽑아 넘겨야
 *  한다. entry 를 못 주는 경우(합성 DataTransfer 등)는 getAsFile 의 File 로 폴백 — 파일 한 장 */
export type DroppedEntry = FileSystemEntry | File;

function entryFile(e: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => e.file(resolve, reject));
}

/** readEntries 는 배치(크롬 100개)로 온다 — 빈 배치까지 반복 */
async function dirEntries(e: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = e.createReader();
  const out: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return out;
    out.push(...batch);
  }
}

/** 드롭된 항목을 재귀로 걷어 파일(File·원격 경로)과 만들 폴더를 모은다 — 폴더는 상위부터 */
async function collectDropped(
  entries: DroppedEntry[],
  dir: string,
  files: Array<{ file: File; path: string }>,
  dirs: string[],
): Promise<void> {
  for (const e of entries) {
    const path = dir === '' ? e.name : `${dir}/${e.name}`;
    if (e instanceof File) {
      files.push({ file: e, path });
    } else if (e.isDirectory) {
      dirs.push(path);
      await collectDropped(await dirEntries(e as FileSystemDirectoryEntry), path, files, dirs);
    } else if (e.isFile) {
      files.push({ file: await entryFile(e as FileSystemFileEntry), path });
    }
  }
}

/** 로컬 File 하나를 원격 path 로 — 4MB 조각, 첫 조각이 파일을 새로 만들고 이후는 append */
async function uploadFile(backend: ThinBackend, file: File, path: string, onBytes: (n: number) => void): Promise<void> {
  if (file.size === 0) {
    await backend.writeFile(path, '', undefined, 'base64');
    return;
  }
  for (let off = 0; off < file.size; off += CHUNK) {
    const data = await blobToBase64(file.slice(off, off + CHUNK));
    await backend.writeFile(path, data, undefined, 'base64', off > 0);
    onBytes(Math.min(CHUNK, file.size - off));
  }
}

/**
 * 탐색기 OS 드롭 업로드 — entries 를 원격 dir 아래로. 같은 이름의 최상위 항목이 이미 있으면
 * confirmReplace 로 묻고(취소면 무동작), 승인 시 덮어쓴다. 끝나면 dir 을 리프레시. 진행은 바이트
 */
export async function uploadDropped(
  dir: string,
  entries: DroppedEntry[],
  confirmReplace: (names: string[]) => Promise<boolean>,
): Promise<void> {
  if (entries.length === 0) return;
  if (rejectIfBusy()) return;
  const { backend, files: filesM, workbench: wbM } = ctx();
  const where = dir === '' ? wbM.workbench.workspaceName : dir;
  let dupes: string[];
  try {
    const existing = new Set((await backend.readDir(dir)).map((e) => e.name));
    dupes = entries.map((e) => e.name).filter((n) => existing.has(n));
  } catch (e) {
    notify('error', `Upload failed: ${errText(e)}`);
    return;
  }
  if (dupes.length > 0 && !(await confirmReplace(dupes))) return;
  const label = entries.length === 1 ? `Uploading ${entries[0].name}` : `Uploading ${entries.length} items`;
  const ok = await run(label, async (progress) => {
    const files: Array<{ file: File; path: string }> = [];
    const dirs: string[] = [];
    await collectDropped(entries, dir, files, dirs);
    const total = files.reduce((s, f) => s + f.file.size, 0);
    let done = 0;
    progress(0, total);
    // 폴더는 이미 있을 수 있다 (덮어쓰기 승인) — createDir 은 배타적이라 실패는 무시하고 파일
    // 쓰기가 진짜 오류(권한 등)를 드러내게 둔다
    for (const d of dirs) await backend.createDir(d).catch(() => {});
    for (const f of files) {
      await uploadFile(backend, f.file, f.path, (n) => progress((done += n), total));
    }
  });
  await filesM.refreshDir(dir);
  filesM.invalidateQuickOpen();
  if (ok) notify('info', `Uploaded ${entries.length === 1 ? `'${entries[0].name}'` : `${entries.length} items`} to '${where}'`);
}
