import type { SaveDialogOptions } from '@tauri-apps/plugin-dialog';

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
export const GPX_EXTENSION = 'gpx';
export const COMPASS_EXTENSIONS = ['mak', 'dat'];

export function tmlOpenFilters() {
  return [
    { name: 'Ariane Survey', extensions: TML_EXTENSIONS },
    { name: 'All Files', extensions: ['*'] },
  ];
}

export function compassOpenFilters() {
  return [
    { name: 'Compass Survey', extensions: COMPASS_EXTENSIONS },
    { name: 'All Files', extensions: ['*'] },
  ];
}

export function gpxOpenFilters() {
  return [
    { name: 'GPX Files', extensions: [GPX_EXTENSION] },
    { name: 'All Files', extensions: ['*'] },
  ];
}

export function importOpenFilters() {
  return [
    { name: 'Survey Files', extensions: [DMP_EXTENSION, ...TML_EXTENSIONS, GPX_EXTENSION, ...COMPASS_EXTENSIONS] },
    { name: 'mNemo DMP', extensions: [DMP_EXTENSION] },
    { name: 'Ariane Survey', extensions: TML_EXTENSIONS },
    { name: 'Compass Survey', extensions: COMPASS_EXTENSIONS },
    { name: 'GPX Files', extensions: [GPX_EXTENSION] },
    { name: 'All Files', extensions: ['*'] },
  ];
}

export function exportSaveFilters(label: string, extension: string) {
  const normalizedExt = extension.startsWith('.') ? extension.slice(1) : extension;
  return [{ name: label, extensions: [normalizedExt] }];
}

/**
 * Wrapper around Tauri's `save()` dialog that fixes Android compatibility.
 *
 * On Android, the native SAF save dialog (ACTION_CREATE_DOCUMENT) returns
 * content:// URIs that the Rust backend cannot use as filesystem paths, and
 * the activity result callback is unreliable on some devices (e.g. Boox).
 * Instead, we show an in-app directory picker + filename input. This requires
 * MANAGE_EXTERNAL_STORAGE permission.
 *
 * On desktop, delegates to the native save dialog.
 */
export async function saveDialog(options?: SaveDialogOptions): Promise<string | null> {
  if (navigator.userAgent.includes('Android')) {
    // Try the native SAF dialog first. If the result is a content:// URI,
    // extract the filesystem path. Fall back to the in-app picker if the
    // native dialog hangs or fails.
    const result = await Promise.race([
      nativeSaveDialog(options),
      // If the native dialog doesn't resolve within 2 minutes, it's hung
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 120_000)),
    ]);

    if (result === 'timeout' || result === null) {
      // Native dialog hung or was cancelled — fall back to in-app picker
      return result === 'timeout' ? androidSaveDialog(options) : null;
    }

    // Convert content:// URI to filesystem path
    return resolveAndroidPath(result);
  }

  const { save } = await import('@tauri-apps/plugin-dialog');

  if (options?.defaultPath && !isAbsolutePath(options.defaultPath)) {
    try {
      const { documentDir, sep } = await import('@tauri-apps/api/path');
      const dir = await documentDir();
      // Only prepend a real absolute documents dir; otherwise let the native
      // dialog pick its own default rather than producing a relative path.
      if (dir && isAbsolutePath(dir)) {
        options = { ...options, defaultPath: `${dir}${sep()}${options.defaultPath}` };
      }
    } catch {
      // Documents dir unavailable — fall back to the native dialog default.
    }
  }

  return save(options);
}

async function nativeSaveDialog(options?: SaveDialogOptions): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  return save(options);
}

/**
 * Convert Android content:// URIs or raw paths to filesystem paths.
 * Common patterns from SAF:
 *   content://com.android.providers.downloads.documents/document/raw:/storage/emulated/0/Download/file.stalx
 *   content://com.android.externalstorage.documents/document/primary:Download/file.stalx
 */
function resolveAndroidPath(uri: string): string {
  // Already a filesystem path
  if (uri.startsWith('/')) return uri;

  // Try to extract path from raw:/ pattern (Downloads provider)
  const rawMatch = uri.match(/raw[:%]3A(.+)/i);
  if (rawMatch) {
    return decodeURIComponent(rawMatch[1]!);
  }

  // Try to extract from primary: pattern (external storage provider)
  const primaryMatch = uri.match(/primary[:%]3A(.+)/i);
  if (primaryMatch) {
    return `/storage/emulated/0/${decodeURIComponent(primaryMatch[1]!)}`;
  }

  // Can't parse — return as-is and hope for the best
  return uri;
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(p);
}

interface AndroidDir { label: string; path: string }

async function getAndroidDirs(): Promise<AndroidDir[]> {
  const { downloadDir, documentDir } = await import('@tauri-apps/api/path');
  const dirs: AndroidDir[] = [];
  try { dirs.push({ label: 'Downloads', path: await downloadDir() }); } catch { /* skip */ }
  try { dirs.push({ label: 'Documents', path: await documentDir() }); } catch { /* skip */ }
  // Common shared storage paths
  const shared = '/storage/emulated/0';
  if (!dirs.some(d => d.path.includes('Download'))) {
    dirs.push({ label: 'Downloads', path: `${shared}/Download` });
  }
  if (!dirs.some(d => d.path.includes('Document'))) {
    dirs.push({ label: 'Documents', path: `${shared}/Documents` });
  }
  return dirs;
}

/**
 * Shows an in-app save dialog for Android: a directory picker dropdown + filename input.
 * Returns the full filesystem path, or null if cancelled.
 */
async function androidSaveDialog(options?: SaveDialogOptions): Promise<string | null> {
  const dirs = await getAndroidDirs();
  const defaultFilename = options?.defaultPath
    ? options.defaultPath.split('/').pop()!.split('\\').pop()!
    : 'untitled';

  return new Promise<string | null>((resolve) => {
    // Build modal DOM
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:var(--color-bg-primary,#1e1e2e);color:var(--color-text-primary,#cdd6f4);border-radius:12px;padding:24px;min-width:340px;max-width:90vw;font-family:inherit;box-shadow:0 8px 32px rgba(0,0,0,0.4)';

    const title = options?.title ?? 'Save File';
    dialog.innerHTML = `
      <h3 style="margin:0 0 16px;font-size:16px;font-weight:600">${title}</h3>
      <label style="display:block;font-size:13px;color:var(--color-text-secondary,#a6adc8);margin-bottom:4px">Save to</label>
      <select id="android-save-dir" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--color-border,#45475a);background:var(--color-bg-secondary,#313244);color:inherit;font-size:14px;margin-bottom:12px">
        ${dirs.map((d, i) => `<option value="${i}">${d.label} (${d.path})</option>`).join('')}
      </select>
      <label style="display:block;font-size:13px;color:var(--color-text-secondary,#a6adc8);margin-bottom:4px">File name</label>
      <input id="android-save-filename" type="text" value="${defaultFilename}" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--color-border,#45475a);background:var(--color-bg-secondary,#313244);color:inherit;font-size:14px;box-sizing:border-box" />
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px">
        <button id="android-save-cancel" style="padding:8px 16px;border-radius:6px;border:1px solid var(--color-border,#45475a);background:transparent;color:inherit;cursor:pointer;font-size:14px">Cancel</button>
        <button id="android-save-confirm" style="padding:8px 16px;border-radius:6px;border:none;background:var(--color-accent,#89b4fa);color:var(--color-bg-primary,#1e1e2e);cursor:pointer;font-weight:600;font-size:14px">Save</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const filenameInput = dialog.querySelector('#android-save-filename') as HTMLInputElement;
    const dirSelect = dialog.querySelector('#android-save-dir') as HTMLSelectElement;
    const confirmBtn = dialog.querySelector('#android-save-confirm') as HTMLButtonElement;
    const cancelBtn = dialog.querySelector('#android-save-cancel') as HTMLButtonElement;

    // Select filename without extension for easy editing
    requestAnimationFrame(() => {
      filenameInput.focus();
      const dotIndex = defaultFilename.lastIndexOf('.');
      if (dotIndex > 0) {
        filenameInput.setSelectionRange(0, dotIndex);
      }
    });

    const cleanup = () => { document.body.removeChild(overlay); };

    confirmBtn.addEventListener('click', () => {
      const dir = dirs[parseInt(dirSelect.value)];
      const fname = filenameInput.value.trim();
      cleanup();
      if (!fname || !dir) { resolve(null); return; }
      resolve(`${dir.path}/${fname}`);
    });

    cancelBtn.addEventListener('click', () => {
      cleanup();
      resolve(null);
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { cleanup(); resolve(null); }
    });
  });
}
