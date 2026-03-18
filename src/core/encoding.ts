/**
 * 编码处理：decode/encode/stripAnsi
 * 纯函数，无外部依赖（iconv-lite 可选）。
 */

let iconv: typeof import("iconv-lite") | null = null;
try {
  iconv = require("iconv-lite");
} catch {}

export function decode(buf: Buffer, enc: string): string {
  try {
    if (iconv && enc && enc !== "utf8") return iconv.decode(buf, enc);
    return buf.toString("utf8");
  } catch {
    return buf.toString("latin1");
  }
}

export function encode(str: string, enc: string): Buffer<ArrayBufferLike> {
  try {
    if (iconv && enc && enc !== "utf8") return iconv.encode(str, enc);
  } catch {}
  return Buffer.from(str, "utf8");
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — stripping ANSI/Telnet control bytes
const ANSI_RE = /\x1b\[[0-9;]*[mGKHFJABCDsuhlrnHf]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — stripping Telnet IAC sequences
const TELNET_IAC_RE = /\xff[\xfb-\xff][\x00-\xff]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — stripping non-printable control chars
const CTRL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function stripAnsi(t: string): string {
  return t.replace(ANSI_RE, "").replace(TELNET_IAC_RE, "").replace(CTRL_CHAR_RE, "").replace(/\r/g, "");
}
