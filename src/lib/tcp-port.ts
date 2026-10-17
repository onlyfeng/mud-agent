// 三个入口（/mud start、mud_admin setup、mud-ctl setup）共用的端口校验：只接受 1–65535 的整数，
// 否则 "not-a-port" 这类值会以 parseInt → NaN → JSON null 写进配置，派生一个永远连不上的 daemon 却报告成功。
export function parseTcpPort(raw: unknown): number | null {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}
