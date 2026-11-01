import { describe, it, expect } from 'vitest';
import { isWindowsPath, parentDir, siblingPath } from '../path';

// '\' is an ordinary file-name character on Linux and macOS, so only a
// Windows-shaped path may split on it (#576).
const POSIX_PATHS = [
  '/home/u/caves/CaveA.stalx',
  '/home/u/we\\ird.stalx',
  '/CaveA.stalx',
  'CaveA.stalx',
  '/home/u/caves//CaveA.stalx',
];

describe('isWindowsPath', () => {
  it.each([
    'C:\\caves\\CaveA.stalx',
    'c:/caves/CaveA.stalx',
    'C:\\CaveA.stalx',
    '\\\\srv\\share\\CaveA.stalx',
    '\\\\?\\C:\\caves\\CaveA.stalx',
  ])('recognises %s', (path) => {
    expect(isWindowsPath(path)).toBe(true);
  });

  it.each([...POSIX_PATHS, 'C:CaveA.stalx', '\\CaveA.stalx'])('does not recognise %s', (path) => {
    expect(isWindowsPath(path)).toBe(false);
  });
});

describe('parentDir', () => {
  // The '/'-only split both call sites used before Windows support.
  it.each(POSIX_PATHS)('splits the POSIX path %s on / alone', (path) => {
    expect(parentDir(path)).toBe(path.substring(0, path.lastIndexOf('/')));
  });

  it.each([
    ['C:\\caves\\CaveA.stalx', 'C:\\caves'],
    ['C:/caves\\CaveA.stalx', 'C:/caves'],
    ['\\\\srv\\share\\CaveA.stalx', '\\\\srv\\share'],
    // A bare 'C:' is the current directory on drive C, not its root.
    ['C:\\CaveA.stalx', 'C:\\'],
    ['C:/CaveA.stalx', 'C:/'],
  ])('gives the folder of the Windows path %s', (path, expected) => {
    expect(parentDir(path)).toBe(expected);
  });
});

describe('siblingPath', () => {
  it.each(POSIX_PATHS)('joins next to the POSIX path %s with /', (path) => {
    expect(siblingPath(path, 'out.stalx')).toBe(`${path.substring(0, path.lastIndexOf('/'))}/out.stalx`);
  });

  it.each([
    ['C:\\caves\\CaveA.stalx', 'C:\\caves\\out.stalx'],
    ['C:\\CaveA.stalx', 'C:\\out.stalx'],
    ['C:/caves\\CaveA.stalx', 'C:/caves\\out.stalx'],
    ['C:/caves/CaveA.stalx', 'C:/caves/out.stalx'],
    ['\\\\srv\\share\\CaveA.stalx', '\\\\srv\\share\\out.stalx'],
  ])('joins next to the Windows path %s with its own separator', (path, expected) => {
    expect(siblingPath(path, 'out.stalx')).toBe(expected);
  });
});
