/**
 * The SpeleoDB web deep-link builder. The refusals matter more than the happy
 * path: a URL we cannot open (no id, or a scheme the `opener:default` capability
 * forbids) must come back null so the caller disables the affordance instead of
 * firing a call that can only fail.
 */
import { describe, it, expect } from 'vitest';
import { speleoProjectUrl } from '../speleoWebUrl';

const ID = 'abc-123';

describe('speleoProjectUrl', () => {
  it('builds the project root from an endpoint with no trailing slash', () => {
    expect(speleoProjectUrl('https://www.speleodb.org', ID)).toBe(
      'https://www.speleodb.org/private/project/abc-123/',
    );
  });

  it('strips one or many trailing slashes from the endpoint', () => {
    const expected = 'https://www.speleodb.org/private/project/abc-123/';
    expect(speleoProjectUrl('https://www.speleodb.org/', ID)).toBe(expected);
    expect(speleoProjectUrl('https://www.speleodb.org///', ID)).toBe(expected);
  });

  it('appends each sub-page with its own trailing slash', () => {
    expect(speleoProjectUrl('https://x.test', ID, 'revisions')).toBe(
      'https://x.test/private/project/abc-123/revisions/',
    );
    expect(speleoProjectUrl('https://x.test', ID, 'permissions/user')).toBe(
      'https://x.test/private/project/abc-123/permissions/user/',
    );
  });

  it('accepts a plain http endpoint', () => {
    expect(speleoProjectUrl('http://localhost:8000', ID)).toBe(
      'http://localhost:8000/private/project/abc-123/',
    );
  });

  it('percent-encodes the project id', () => {
    expect(speleoProjectUrl('https://x.test', 'a/b c')).toBe(
      'https://x.test/private/project/a%2Fb%20c/',
    );
  });

  it('returns null without a usable project id', () => {
    expect(speleoProjectUrl('https://x.test', null)).toBeNull();
    expect(speleoProjectUrl('https://x.test', undefined)).toBeNull();
    expect(speleoProjectUrl('https://x.test', '   ')).toBeNull();
  });

  it('returns null without a usable endpoint', () => {
    expect(speleoProjectUrl(null, ID)).toBeNull();
    expect(speleoProjectUrl(undefined, ID)).toBeNull();
    expect(speleoProjectUrl('   ', ID)).toBeNull();
  });

  it('returns null for a scheme the opener capability does not permit', () => {
    // opener:default allows http/https only, so anything else is a dead button.
    expect(speleoProjectUrl('file:///etc', ID)).toBeNull();
    expect(speleoProjectUrl('ftp://x.test', ID)).toBeNull();
    expect(speleoProjectUrl('www.speleodb.org', ID)).toBeNull();
  });
});
