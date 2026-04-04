/** RFC1918 私网 IPv4；与 localhost 一样应用「当前主机名 + 固定端口」解析 API / audio-helper（仅直连模式）。 */
export function isPrivateLanIPv4Hostname(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Tailscale / CGNAT 100.64.0.0/10
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}
