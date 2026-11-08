/**
 * What a baked `STALAGMIGHT_PRERELEASE` value means (#650): read by
 * vite.config.ts to build About's version, so About shows the version the
 * backend compares update offers against.
 *
 * The SAME rule as `effective_version` in src-tauri/src/commands/app_update.rs,
 * and pinned by the same cases in `__tests__/semverPrerelease.test.ts`: trimmed;
 * unset or blank is a final release; otherwise it must be semver pre-release
 * identifiers (dot-separated, `[0-9A-Za-z-]`, no empty identifier, no leading
 * zero in a numeric one) and must not start with a hyphen. The two are one rule
 * across the language boundary and must be changed together.
 *
 * No Node or browser APIs, so the vite config and the test can both import it.
 */

/** One semver pre-release identifier: numeric without a leading zero, or alphanumeric. */
const IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const PRERELEASE = new RegExp(`^${IDENTIFIER}(?:\\.${IDENTIFIER})*$`);

export type BakedPrerelease =
  /** Unset or blank: a final release, whose version is the package version. */
  | { kind: 'final' }
  /** A release candidate's pre-release part, trimmed, e.g. `rc.2`. */
  | { kind: 'candidate'; prerelease: string }
  /** Not usable; the caller warns and falls back to the plain version. */
  | { kind: 'invalid'; value: string };

export function readBakedPrerelease(raw: string | undefined): BakedPrerelease {
  const value = (raw ?? '').trim();
  if (value === '') return { kind: 'final' };
  // Semver accepts a leading hyphen (`-rc.2` is the identifier `-rc`), but
  // `0.5.2--rc.2` sorts below `0.5.2-rc.1`, so it is refused here as in Rust.
  if (value.startsWith('-') || !PRERELEASE.test(value)) return { kind: 'invalid', value };
  return { kind: 'candidate', prerelease: value };
}
