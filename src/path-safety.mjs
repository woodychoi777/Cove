import nodePath from 'node:path';

// relative() handles drive letters, Windows case rules, and path separators.
export function isWithin(path, root, paths = nodePath) {
  const relative = paths.relative(root, path);
  return relative === '' || !paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + paths.sep);
}
