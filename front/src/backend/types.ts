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
  /** HEAD 커밋 해시 — diff original 캐시 무효화 키 (앱 밖 커밋도 잡는다). unborn/비 git 은 '' */
  head: string;
  /** 워킹트리에 변경이 있으면 true (브랜치명 옆 '*' 표시용) */
  dirty: boolean;
  changes: GitChange[];
}

export interface FsChange {
  /** 루트 기준 상대 경로 */
  path: string;
  kind: 'create' | 'change' | 'delete';
}

/** 텍스트 편집기에 표시할 수 없는 사유 — 파일은 실존하므로 탭은 열리고 안내 화면이 뜬다.
 *  large 는 크기 상한 초과(size 는 실측 바이트 — 안내 문구에 표시), binary 는 이진이거나
 *  UTF-8 이 아닌 인코딩. */
export type Unopenable = { kind: 'large'; size: number } | { kind: 'binary' };

/** unopenable 이면 content 는 없다 — etag 는 양쪽 다 온다 (orphan 재검증·재로드용). */
export type FileContent =
  | { content: string; etag: string; unopenable?: undefined }
  | { content?: undefined; etag: string; unopenable: Unopenable };

export interface FileStat {
  /** readFile 의 etag 와 같은 (mtime,size) 기반 불투명 토큰 */
  etag: string;
}

/** conflict 면 쓰지 않았다 — etag 시점 이후 디스크가 바뀌었고 내용도 다르다. */
export type WriteResult =
  | { etag: string; conflict?: undefined }
  | { etag?: undefined; conflict: true };

/** mock PTY 세션. 실제 백엔드에서는 원격 PTY 로 대체된다. */
export interface TerminalSession {
  /** 백엔드 구현이 발급하는 식별자 — onSessionLost 의 죽은 터미널 명단과 대조하는 용도 */
  readonly id: number;
  write(data: string): void;
  /** done 이 오면 구독자는 청크 처리(xterm 그리기)를 마친 뒤 호출해야 한다 —
   *  WsBackend 가 이를 ack 시점으로 삼아 렌더러 속도를 배압에 반영한다 (mock 은 생략). */
  onData(cb: (data: string, done?: () => void) => void): void;
  /** 셸이 스스로 종료(exit·crash)하면 exit code 와 함께 발화 (spawn 실패는 null).
   *  dispose 로 인한 정리에는 발화하지 않는다. */
  onExit(cb: (code: number | null) => void): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

export interface ThinBackend {
  workspace(): Promise<WorkspaceInfo>;
  /** path 디렉토리의 직계 엔트리. 정렬은 호출자 책임. */
  readDir(path: string): Promise<DirEntry[]>;
  /** 크기 초과(maxBytes 또는 백엔드 기본 상한)·이진/미지원 인코딩은 reject 가 아니라
   *  unopenable 로 온다 — 실존하지 않는 경로 등 실제 실패만 reject 다. maxBytes 는
   *  undo 캡처 등 호출측 상한 (초과 파일을 읽어 나르지 않는다). */
  readFile(path: string, opts?: { maxBytes?: number }): Promise<FileContent>;
  /** 내용 없이 실존·변경만 확인하는 경량 검사 — 정규 파일 전용(디렉토리는 reject). orphan 재검증용 */
  stat(path: string): Promise<FileStat>;
  /**
   * etag 를 주면 낙관적 충돌 검사 — 불일치(+내용 상이) 시 쓰지 않고 conflict. 생략 시 무조건 쓴다.
   * encoding: 'base64' 면 content 를 이진으로 디코드해 쓴다 (클립보드 이미지 저장 등) —
   * JSON 텍스트 와이어의 이진 통로. 생략 시 UTF-8 텍스트 그대로.
   */
  writeFile(path: string, content: string, etag?: string, encoding?: 'base64'): Promise<WriteResult>;
  /** 빈 파일 배타적 생성 — 중간 디렉토리 자동 생성, 이미 존재하면 reject (기존 내용 보호) */
  createFile(path: string): Promise<void>;
  /** 디렉토리 배타적 생성 — 중간 디렉토리 자동, 이미 존재하면 reject (undo 의 "내가 만든 것" 전제 보호) */
  createDir(path: string): Promise<void>;
  /** 이름 변경/이동 — 대상이 이미 존재하면 reject */
  rename(from: string, to: string): Promise<void>;
  /** 파일·디렉토리 겸용 삭제 (디렉토리는 재귀, 휴지통 없음) */
  delete(path: string): Promise<void>;
  /** 워크스페이스 전체 파일 경로 목록 (quick open 용) */
  listFiles(): Promise<string[]>;
  /**
   * '폴더 열기' 경로 탐색용 — 임의 절대 경로의 하위 디렉토리 이름 나열 (정렬됨).
   * 실 백엔드 전용 (mock 은 가짜 트리 밖 경로가 없어 미구현 — 커맨드 등록의 지원 신호로도 쓴다).
   */
  browseDir?(path: string): Promise<string[]>;
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
  /**
   * 연결 상태 변화 구독 (mock 은 끊길 일이 없어 미구현). 재연결 시 true — 끊김 중 놓친
   * 변경은 복구할 수 없으므로 구독자가 전체 리프레시로 재동기화해야 한다.
   */
  onConnection?(cb: (connected: boolean) => void): void;
  /**
   * 터미널 입력 배압 상태 구독 (옵셔널 — mock 은 즉시 소화라 미구현). 셸이 입력을 읽지
   * 않아 미소화 전송량이 창을 넘으면 (TerminalSession.id, true) — 이후 입력은 로컬 대기.
   * 대기분이 모두 나가면 false.
   */
  onInputBlocked?(cb: (term: number, blocked: boolean) => void): void;
  /**
   * 재연결은 됐지만 데몬 세션이 회수된 경우(장기 끊김) 구독. deadTerms 는 죽은 터미널의
   * TerminalSession.id 명단 — 구독자가 정리해야 응답 없는 유령 터미널이 남지 않는다.
   * 끊김 중에 만든 터미널은 재연결 큐 flush 로 새 세션에 살아 있으므로 명단 밖이다.
   */
  onSessionLost?(cb: (deadTerms: number[]) => void): void;
}
