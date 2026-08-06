import { describe, it, expect } from 'vitest';
import { pathElisionCandidates } from '../pathElision';

describe('pathElisionCandidates', () => {
  it('returns the full path first', () => {
    const path = '/home/user/surveys/orda/main-line/spring.stalx';
    expect(pathElisionCandidates(path)[0]).toBe(path);
  });

  it('abbreviates leading folders left to right, keeping the filename whole', () => {
    const path = '/home/user/surveys/orda/main-line/spring.stalx';
    const candidates = pathElisionCandidates(path);

    // First abbreviation only touches the leftmost folder.
    expect(candidates[1]).toBe('/h/user/surveys/orda/main-line/spring.stalx');
    // All folders abbreviated appears before any middle-truncation.
    expect(candidates).toContain('/h/u/s/o/m/spring.stalx');
    // The filename is never abbreviated.
    for (const c of candidates) {
      expect(c.endsWith('spring.stalx')).toBe(true);
    }
  });

  it('middle-truncates with an ellipsis once all folders are abbreviated', () => {
    const path = '/home/user/surveys/orda/main-line/spring.stalx';
    const candidates = pathElisionCandidates(path);

    expect(candidates).toContain('/h/u/s/o/…/spring.stalx');
    expect(candidates).toContain('/…/spring.stalx');
    // The most-elided candidate is last and shortest.
    expect(candidates[candidates.length - 1]).toBe('/…/spring.stalx');
  });

  it('orders candidates from longest to shortest', () => {
    const candidates = pathElisionCandidates('/a/bb/ccc/dddd/file.stalx');
    for (let i = 1; i < candidates.length; i++) {
      const current = candidates[i] as string;
      const previous = candidates[i - 1] as string;
      expect(current.length).toBeLessThanOrEqual(previous.length);
    }
  });

  it('returns a bare filename unchanged (nothing to elide)', () => {
    expect(pathElisionCandidates('spring.stalx')).toEqual(['spring.stalx']);
    expect(pathElisionCandidates('/spring.stalx')).toEqual(['/spring.stalx']);
  });

  it('handles a single folder above the filename', () => {
    expect(pathElisionCandidates('/caves/spring.stalx')).toEqual([
      '/caves/spring.stalx',
      '/c/spring.stalx',
      '/…/spring.stalx',
    ]);
  });

  it('handles relative paths without a leading separator', () => {
    const candidates = pathElisionCandidates('surveys/orda/spring.stalx');
    expect(candidates[0]).toBe('surveys/orda/spring.stalx');
    expect(candidates).toContain('s/o/spring.stalx');
    expect(candidates[candidates.length - 1]).toBe('…/spring.stalx');
  });

  it('handles Windows-style backslash paths', () => {
    const candidates = pathElisionCandidates('C:\\Users\\user\\spring.stalx');
    expect(candidates[0]).toBe('C:\\Users\\user\\spring.stalx');
    // Backslash is preserved as the separator throughout, and the drive with it.
    for (const c of candidates) {
      expect(c.includes('/')).toBe(false);
      expect(c.startsWith('C:\\')).toBe(true);
      expect(c.endsWith('spring.stalx')).toBe(true);
    }
    expect(candidates[candidates.length - 1]).toBe('C:\\…\\spring.stalx');
  });

  it('renders forward-slash-stored Windows paths with backslashes', () => {
    const candidates = pathElisionCandidates('C:/Users/user/caves/spring.stalx');
    expect(candidates[0]).toBe('C:\\Users\\user\\caves\\spring.stalx');
    for (const c of candidates) {
      expect(c.includes('/')).toBe(false);
      expect(c.startsWith('C:\\')).toBe(true);
    }
  });

  it('middle-truncates deep Windows paths instead of abbreviating segments', () => {
    const path = 'C:/Users/Alice/AppData/Local/Temp/claude/Foo/0/scratchpad/win/work/project-copy.stalx';
    const candidates = pathElisionCandidates(path);

    expect(candidates[1]).toBe(
      'C:\\…\\Alice\\AppData\\Local\\Temp\\claude\\Foo\\0\\scratchpad\\win\\work\\project-copy.stalx'
    );
    expect(candidates).toContain('C:\\…\\win\\work\\project-copy.stalx');
    expect(candidates[candidates.length - 1]).toBe('C:\\…\\project-copy.stalx');
    // The drive, the ellipsis once elided, and the filename always survive.
    for (const c of candidates) {
      expect(c.startsWith('C:\\')).toBe(true);
      expect(c.endsWith('\\project-copy.stalx')).toBe(true);
      expect(/[A-Za-z]:\\[A-Za-z]\\/.test(c)).toBe(false);
    }
    for (const c of candidates.slice(1)) {
      expect(c.includes('…')).toBe(true);
    }
  });

  it('fits a deep Windows path into a tight width without letter soup', () => {
    const path = 'C:/Users/Alice/AppData/Local/Temp/claude/Foo/0/scratchpad/win/work/project-copy.stalx';
    const candidates = pathElisionCandidates(path);
    // Mirrors ElidedPath: first candidate that fits, else the most-elided one.
    const fitted =
      candidates.find((c) => c.length <= 40) ?? (candidates[candidates.length - 1] as string);

    expect(fitted).toBe('C:\\…\\win\\work\\project-copy.stalx');
  });

  it('keeps the UNC host and share out of the elision', () => {
    const candidates = pathElisionCandidates('\\\\server\\share\\caves\\orda\\spring.stalx');
    expect(candidates).toEqual([
      '\\\\server\\share\\caves\\orda\\spring.stalx',
      '\\\\server\\share\\…\\orda\\spring.stalx',
      '\\\\server\\share\\…\\spring.stalx',
    ]);
  });

  it('normalises mixed separators on a Windows path', () => {
    const candidates = pathElisionCandidates('C:/Users\\Alice/caves\\orda/spring.stalx');
    expect(candidates[0]).toBe('C:\\Users\\Alice\\caves\\orda\\spring.stalx');
    expect(candidates[candidates.length - 1]).toBe('C:\\…\\spring.stalx');
  });

  it('orders Windows candidates from longest to shortest', () => {
    const candidates = pathElisionCandidates('C:/Users/Alice/caves/orda/main-line/spring.stalx');
    for (let i = 1; i < candidates.length; i++) {
      const current = candidates[i] as string;
      const previous = candidates[i - 1] as string;
      expect(current.length).toBeLessThanOrEqual(previous.length);
    }
  });

  it('leaves a Windows path with no folders alone (separator aside)', () => {
    expect(pathElisionCandidates('C:/spring.stalx')).toEqual(['C:\\spring.stalx']);
    expect(pathElisionCandidates('C:\\spring.stalx')).toEqual(['C:\\spring.stalx']);
  });

  it('drops consecutive duplicate renderings (already single-char folders)', () => {
    const candidates = pathElisionCandidates('/a/b/file.stalx');
    const unique = candidates.filter((c, i) => i === 0 || c !== candidates[i - 1]);
    expect(candidates).toEqual(unique);
  });

  it('returns a single empty string for empty input', () => {
    expect(pathElisionCandidates('')).toEqual(['']);
  });
});
