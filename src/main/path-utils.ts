import path from "node:path";

const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9"
]);

export function sanitizeName(input: string, fallback = "未命名"): string {
  const cleaned = input
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  if (!cleaned) {
    return fallback;
  }
  if (WINDOWS_RESERVED_NAMES.has(cleaned.toLowerCase())) {
    return `${cleaned}_`;
  }
  return cleaned;
}

export function uniquePathParts(fileName: string): { base: string; ext: string } {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  return {
    base: sanitizeName(base, "文件"),
    ext: sanitizeName(ext, "")
  };
}
