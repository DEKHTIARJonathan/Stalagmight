export const PROJECT_EXTENSION = 'stalx';
export const DMP_EXTENSION = 'dmp';

export function ensureExtension(path: string, extension: string): string {
  const normalizedExt = extension.startsWith('.') ? extension.slice(1) : extension;
  const lowerPath = path.toLowerCase();
  const lowerExt = normalizedExt.toLowerCase();

  if (lowerPath.endsWith(`.${lowerExt}`)) {
    return path;
  }

  const lastSeparator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const lastDot = path.lastIndexOf('.');
  if (lastDot > lastSeparator) {
    return `${path.slice(0, lastDot + 1)}${normalizedExt}`;
  }

  return `${path}.${normalizedExt}`;
}

export function projectOpenFilters() {
  return [
    { name: 'Stalagmight Project', extensions: [PROJECT_EXTENSION] },
    { name: 'All Files', extensions: ['*'] },
  ];
}

export function projectSaveFilters() {
  return [{ name: 'Stalagmight Project', extensions: [PROJECT_EXTENSION] }];
}

export function dmpOpenFilters() {
  return [
    { name: 'mNemo DMP', extensions: [DMP_EXTENSION] },
    { name: 'All Files', extensions: ['*'] },
  ];
}

export const TML_EXTENSIONS = ['tml', 'tmlu'];

export function tmlOpenFilters() {
  return [
    { name: 'Ariane Survey', extensions: TML_EXTENSIONS },
    { name: 'All Files', extensions: ['*'] },
  ];
}

export function importOpenFilters() {
  return [
    { name: 'Survey Files', extensions: [DMP_EXTENSION, ...TML_EXTENSIONS] },
    { name: 'mNemo DMP', extensions: [DMP_EXTENSION] },
    { name: 'Ariane Survey', extensions: TML_EXTENSIONS },
    { name: 'All Files', extensions: ['*'] },
  ];
}

export function exportSaveFilters(label: string, extension: string) {
  const normalizedExt = extension.startsWith('.') ? extension.slice(1) : extension;
  return [{ name: label, extensions: [normalizedExt] }];
}
