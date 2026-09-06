/**
 * 저장 전용(무압축) zip 작성기 — 웹 모드 폴더 다운로드용 (ticket explorer-download). 브라우저는
 * 폴더 트리를 저장할 수 없어 폴더는 zip 한 파일로 내려준다. 원격에서 이미 바이트를 받아 온 뒤라
 * 압축의 이득이 없고, 의존성 없이 60줄이면 되므로 라이브러리를 들이지 않았다.
 * ponytail: zip64 없음 — 항목·전체가 4GB 를 넘으면 에러. 파일 시각은 현재 시각 하나.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(crc: number, bytes: Uint8Array): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const MAX32 = 0xffffffff;

interface Entry {
  name: Uint8Array;
  header: DataView;
  offset: number;
  crc: number;
  size: number;
  dir: boolean;
}

/** MS-DOS 시각·날짜 (zip 헤더 필드) */
function dosTime(d: Date): [number, number] {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}

export class ZipWriter {
  private parts: Uint8Array[] = [];
  private entries: Entry[] = [];
  private offset = 0;
  private current: Entry | null = null;
  private readonly stamp = dosTime(new Date());

  /** 항목 시작 — 디렉터리는 이름 끝 '/' + 본문 없음. 로컬 헤더의 crc·크기는 end 에서 채운다 */
  begin(name: string, dir = false): void {
    if (this.current) throw new Error('zip: 이전 항목이 끝나지 않았다');
    const nameBytes = new TextEncoder().encode(dir ? `${name}/` : name);
    const header = new Uint8Array(30 + nameBytes.length);
    const v = new DataView(header.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true); // version needed
    v.setUint16(6, 0x0800, true); // flags: UTF-8 이름
    v.setUint16(8, 0, true); // method: store
    v.setUint16(10, this.stamp[0], true);
    v.setUint16(12, this.stamp[1], true);
    v.setUint16(26, nameBytes.length, true);
    header.set(nameBytes, 30);
    this.current = { name: nameBytes, header: v, offset: this.offset, crc: 0, size: 0, dir };
    this.push(header);
  }

  append(bytes: Uint8Array): void {
    const e = this.current;
    if (!e) throw new Error('zip: 열린 항목이 없다');
    e.crc = crc32(e.crc, bytes);
    e.size += bytes.length;
    if (e.size > MAX32) throw new Error('zip: 4GB 초과 항목은 지원하지 않는다');
    this.push(bytes);
  }

  end(): void {
    const e = this.current;
    if (!e) return;
    e.header.setUint32(14, e.crc, true);
    e.header.setUint32(18, e.size, true);
    e.header.setUint32(22, e.size, true);
    this.entries.push(e);
    this.current = null;
  }

  /** 중앙 디렉터리 + EOCD 를 붙여 완성된 zip 바이트 조각들을 돌려준다 (Blob 재료) */
  finish(): Uint8Array[] {
    this.end();
    const cdStart = this.offset;
    for (const e of this.entries) {
      const cd = new Uint8Array(46 + e.name.length);
      const v = new DataView(cd.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 20, true); // version made by
      v.setUint16(6, 20, true); // version needed
      v.setUint16(8, 0x0800, true);
      v.setUint16(10, 0, true);
      v.setUint16(12, this.stamp[0], true);
      v.setUint16(14, this.stamp[1], true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.size, true);
      v.setUint32(24, e.size, true);
      v.setUint16(28, e.name.length, true);
      v.setUint32(38, e.dir ? 0x10 : 0, true); // external attr: MS-DOS 디렉터리 비트
      v.setUint32(42, e.offset, true);
      cd.set(e.name, 46);
      this.push(cd);
    }
    const cdSize = this.offset - cdStart;
    if (this.offset > MAX32 || this.entries.length > 0xffff) {
      throw new Error('zip: 4GB 또는 65535 항목을 넘는 폴더는 지원하지 않는다');
    }
    const eocd = new Uint8Array(22);
    const v = new DataView(eocd.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, this.entries.length, true);
    v.setUint16(10, this.entries.length, true);
    v.setUint32(12, cdSize, true);
    v.setUint32(16, cdStart, true);
    this.push(eocd);
    return this.parts;
  }

  private push(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.offset += bytes.length;
  }
}
