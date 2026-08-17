import path from "node:path";

export function ancestorPaths(cwd: string, ...parts: string[]) {
  const paths: string[] = [];

  for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
    paths.unshift(path.join(current, ...parts));
    if (path.dirname(current) === current) return paths;
  }
}
