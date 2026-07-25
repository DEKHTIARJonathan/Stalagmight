/**
 * Unit test - #270: a transport failure must never surface a bare OS errno.
 *
 * The reported defect: with the SpeleoDB host blackholed at the routing level the
 * user was shown "Network error talking to SpeleoDB: Invalid argument". That is a
 * raw EINVAL - it says nothing about what failed, offers nothing to do, and does
 * not even hint that the server was unreachable. The humanized line must instead
 * name the configured endpoint (self-hosted users need to know WHICH server) and
 * say what to check, while the raw cause stays on the DTO for the log.
 *
 * The transport case is recognised STRUCTURALLY, from the backend's typed
 * `transport` discriminant - never by matching English substrings of the Rust
 * message (which is locale-dependent: it comes from the platform's strerror).
 *
 * `.tsx` so this runs in the jsdom tier - the i18n singleton it uses is
 * browser-detector backed.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { humanizeSpeleoError } from './speleoError';
import { useSpeleoStore } from '../store/speleoStore';
import type { SpeleoErrorDto } from '../types/ipc.generated';

const ENDPOINT = 'https://cave.example.internal:8443/';

/** The DTO shape `speleodb_*` commands reject with. */
const dto = (over: Partial<SpeleoErrorDto> = {}): SpeleoErrorDto => ({
  message: 'Network error talking to SpeleoDB: Invalid argument',
  action: 'Retry',
  status: null,
  transport: 'Unknown',
  ...over,
});

beforeEach(() => {
  useSpeleoStore.setState({
    session: {
      loggedIn: true,
      userEmail: 'me@example.com',
      endpoint: ENDPOINT,
      keychainBacked: true,
    },
  });
});

describe('humanizeSpeleoError - transport failures (#270)', () => {
  it('never surfaces the raw errno, and names the server that could not be reached', () => {
    const line = humanizeSpeleoError(dto(), 'Could not finish editing');

    expect(line).not.toContain('Invalid argument');
    expect(line).not.toContain('Network error talking to SpeleoDB');
    expect(line).toContain(ENDPOINT);
    expect(line).toMatch(/could not reach/i);
    // Self-framed: the operation prefix is NOT glued on top of it.
    expect(line).not.toContain('Could not finish editing');
  });

  it('keeps the genuinely useful causes distinguishable', () => {
    const refused = humanizeSpeleoError(dto({ transport: 'Refused' }));
    const timeout = humanizeSpeleoError(dto({ transport: 'Timeout' }));
    const dns = humanizeSpeleoError(dto({ transport: 'Dns' }));
    const tls = humanizeSpeleoError(dto({ transport: 'Tls' }));
    const unknown = humanizeSpeleoError(dto({ transport: 'Unknown' }));

    for (const line of [refused, timeout, dns, tls, unknown]) {
      expect(line).toContain(ENDPOINT);
    }
    expect(refused).toMatch(/refused/i);
    expect(timeout).toMatch(/did not respond in time/i);
    expect(dns).toMatch(/could not find/i);
    expect(tls).toMatch(/secure connection/i);
    // The catch-all (EINVAL and friends) stays generic but actionable.
    expect(unknown).toMatch(/check your network connection/i);
    // Four of the five say something the others do not.
    expect(new Set([refused, timeout, dns, tls, unknown]).size).toBe(5);
  });

  it('falls back to a neutral phrase when no session endpoint is known', () => {
    useSpeleoStore.setState({ session: null });
    const line = humanizeSpeleoError(dto({ transport: 'Refused' }));
    expect(line).toContain('the configured server');
    expect(line).not.toContain('undefined');
  });

  it('leaves non-transport errors framed by their operation prefix', () => {
    // `transport` is null for every non-transport error, which is what makes it a
    // sound discriminant: a retryable 5xx is `Retry` too, but carries a status.
    const line = humanizeSpeleoError(
      dto({ message: 'Bad login.', action: 'Fatal', status: 400, transport: null }),
      'Login to SpeleoDB failed',
    );
    expect(line).toBe('Login to SpeleoDB failed: Bad login');
  });

  it('does not treat a retryable 5xx as a transport failure', () => {
    const line = humanizeSpeleoError(
      dto({ message: 'Server error', action: 'Retry', status: 503, transport: null }),
      'Could not push changes',
    );
    expect(line).toBe('Could not push changes: Server error');
  });
});
