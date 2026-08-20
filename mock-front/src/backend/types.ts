/**
 * ThinBackend — 프론트가 원격(또는 mock)에 요구하는 전체 계약.
 *
 * WHY: 이 인터페이스가 프론트와 백엔드 사이의 유일한 seam 이다. 지금은 MockBackend 가
 *      구현하지만, 계약이 안정되면 Rust core(SSH/SFTP/git/rg/PTY)로 구현체만 교체한다.
 *      여기에 UI 개념(탭, 뷰 상태 등)을 넣지 않는다 — 순수하게 워크스페이스 자원만 다룬다.
 */

export interface WorkspaceInfo {
  /** 워크스페이스 루트의 표시 이름 (폴더명) */
  name: string;
  /** 루트 절대 경로. 모든 FileStat.path 는 이 경로 기준의 상대 경로다. */
  rootPath: string;
}

export interface DirEntry {
  name: string;
  /** 루트 기준 상대 경로 (구분자 '/') */
  path: string;
  kind: 'file' | 'directory';
}

export interface SearchMatch {
  /** 0-based 라인 번호 */
  line: number;
  /** 매치가 포함된 라인 전체 텍스트 */
  lineText: string;
  /** 라인 내 매치 시작/끝 컬럼 (0-based, [start, end)) */
  ranges: [number, number][];
}

export interface FileSearchResult {
  path: string;
  matches: SearchMatch[];
}

export type GitChangeKind = 'modified' | 'untracked' | 'deleted' | 'added';

export interface GitChange {
  path: string;
  kind: GitChangeKind;
}

export interface GitStatus {
  branch: string;
  /** 워킹트리에 변경이 있으면 true (브랜치명 옆 '*' 표시용) */
  dirty: boolean;
  changes: GitChange[];
}

export interface FsChange {
  /** 루트 기준 상대 경로 */
  path: string;
  kind: 'create' | 'change' | 'delete';
}

/** mock PTY 세션. 실제 백엔드에서는 원격 PTY 로 대체된다. */
export interface TerminalSession {
  write(data: string): void;
  onData(cb: (data: string) => void): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

export interface ThinBackend {
  workspace(): Promise<WorkspaceInfo>;
  /** path 디렉토리의 직계 엔트리. 정렬은 호출자 책임. */
  readDir(path: string): Promise<DirEntry[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** 워크스페이스 전체 파일 경로 목록 (quick open 용) */
  listFiles(): Promise<string[]>;
  /** 단순 부분 문자열 검색. 대소문자 무시 여부는 옵션. */
  search(query: string, opts?: { caseSensitive?: boolean }): Promise<FileSearchResult[]>;
  gitStatus(): Promise<GitStatus>;
  /** HEAD 시점 파일 내용 (diff 뷰의 original 쪽). untracked 면 빈 문자열. */
  gitOriginalContent(path: string): Promise<string>;
  /** 전체 변경을 커밋 (git add -A && git commit). 성공 후 gitStatus 는 clean 이 된다. */
  gitCommit(message: string): Promise<void>;
  createTerminal(cols: number, rows: number): TerminalSession;
  /**
   * 파일시스템 변경 푸시 구독 (외부 편집·터미널 작업 반영). overflow 면 changes 는 비어
   * 있고 전체 리프레시가 필요하다. mock 은 미구현 — 구독 자체가 없으면 감시도 없다.
   */
  onFsChanges?(cb: (changes: FsChange[], overflow: boolean) => void): void;
}
