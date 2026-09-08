/**
 * EmptyBackend — 루트 없는 빈 세션(시작 페이지 탭)용 무연결 백엔드.
 *
 * 조회 계열은 빈 결과를 돌려 초기 로드(SessionCtx.init)·퀵인풋이 조건 분기 없이
 * 지나가게 하고, 변경 계열은 reject 한다 — 빈 세션에 쓰기가 도달하면 버그다
 * (UI 가 진입로를 막는다). 폴더를 열면 이 백엔드째로 세션이 교체된다.
 */
import type { FileContent, FileSearchResult, FileStat, GitLogItem, GitStatus, QuickOpenResult, TerminalSession, ThinBackend, WorkspaceInfo, WriteResult } from './types';

const NO_FOLDER = '빈 세션 — 열린 폴더가 없다';

export class EmptyBackend implements ThinBackend {
  workspace(): Promise<WorkspaceInfo> {
    return Promise.resolve({ name: '', rootPath: '' });
  }
  readDir(): Promise<[]> {
    return Promise.resolve([]);
  }
  readFile(): Promise<FileContent> {
    return Promise.reject(new Error(NO_FOLDER));
  }
  stat(): Promise<FileStat> {
    return Promise.reject(new Error(NO_FOLDER));
  }
  writeFile(): Promise<WriteResult> {
    return Promise.reject(new Error(NO_FOLDER));
  }
  createFile(): Promise<void> {
    return Promise.reject(new Error(NO_FOLDER));
  }
  createDir(): Promise<void> {
    return Promise.reject(new Error(NO_FOLDER));
  }
  rename(): Promise<void> {
    return Promise.reject(new Error(NO_FOLDER));
  }
  copy(): Promise<void> {
    return Promise.reject(new Error(NO_FOLDER));
  }
  delete(): Promise<void> {
    return Promise.reject(new Error(NO_FOLDER));
  }
  quickOpen(): Promise<QuickOpenResult> {
    return Promise.resolve({ items: [], limitHit: false });
  }
  // browseDir 는 구현하지 않는다 — 나열·확정 검증 불가 신호. 폴더 퀵인풋은
  // sessions.browseBackend 가 형제 연결 세션의 것으로 위임한다
  search(): Promise<FileSearchResult[]> {
    return Promise.resolve([]);
  }
  gitRepos(): Promise<string[]> {
    return Promise.resolve([]);
  }
  gitStatus(): Promise<GitStatus> {
    return Promise.resolve({ branch: '', head: '', dirty: false, changes: [] });
  }
  gitOriginalContent(): Promise<string> {
    return Promise.reject(new Error(NO_FOLDER));
  }
  gitCommit(): Promise<void> {
    return Promise.reject(new Error(NO_FOLDER));
  }
  gitStage(): Promise<void> {
    return Promise.reject(new Error(NO_FOLDER));
  }
  gitUnstage(): Promise<void> {
    return Promise.reject(new Error(NO_FOLDER));
  }
  gitDiscard(): Promise<void> {
    return Promise.reject(new Error(NO_FOLDER));
  }
  gitLog(): Promise<GitLogItem[]> {
    return Promise.resolve([]);
  }
  gitBranches(): Promise<string[]> {
    return Promise.resolve([]);
  }
  gitCheckout(): Promise<void> {
    return Promise.reject(new Error(NO_FOLDER));
  }
  gitFetch(): Promise<void> {
    return Promise.reject(new Error(NO_FOLDER));
  }
  gitPull(): Promise<void> {
    return Promise.reject(new Error(NO_FOLDER));
  }
  gitPush(): Promise<void> {
    return Promise.reject(new Error(NO_FOLDER));
  }
  // 생성 진입로(패널 자동 생성·커맨드)는 activeSessionEmpty 가드가 막는다 —
  // 이 스텁은 경합 잔여 호출의 안전망 (콜백은 발화하지 않는다)
  createTerminal(): TerminalSession {
    return {
      id: 0,
      write: () => {},
      onData: () => {},
      onExit: () => {},
      resize: () => {},
      dispose: () => {},
    };
  }
}
