import path from "node:path";

export function normalizedPath(value: unknown) {
  if (typeof value !== "string" || !value) return undefined;
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function uniquePaths(paths: string[]) {
  return [...new Set(paths.filter(Boolean).map((item) => path.resolve(item)))];
}

export function ancestorPaths(cwd: string, ...parts: string[]) {
  const paths: string[] = [];

  for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
    paths.unshift(path.join(current, ...parts));
    if (path.dirname(current) === current) return paths;
  }
}
