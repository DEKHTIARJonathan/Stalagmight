import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Toggle } from '../../common/Toggle';
import { Select } from '../../common/Select';
import { Button } from '../../common/Button';
import { SettingsSection } from './SettingsSection';
import { SettingRow } from './SettingRow';
import { getPanelId, getTabId } from '../SettingsSidebar';
import type { SettingsCategoryProps } from './types';
import { isFieldChanged, createToggleHandler, createSelectHandler } from './types';
import { defaultConfig } from '../../../types/config';
import type {
  SpeleoLoginResult,
  SpeleoSessionStatus,
  TokenFallback,
} from '../../../types/ipc.generated';
import { useSpeleoStore } from '../../../store/speleoStore';
import { invokeIpc, getErrorMessage } from '../../../utils/ipc';

/**
 * SpeleoDB settings category (#205). Two concerns:
 *
 * - **Connection** — `endpoint` / `token_fallback` / `insecure_http` are staged
 *   config (persisted on the dialog's Save, like every other tab), bound through
 *   the standard `onChange({ speleodb: { … } })` diff path.
 * - **Account** — login / logout are **live, side-effecting** calls that apply
 *   immediately (not on Save) and update the shared `speleoStore` session. The
 *   token is exchanged + stored entirely backend-side; it never reaches here.
 */
export function SpeleoDbSettings({
  config,
  onChange,
  changedFields,
  panelIdBase,
}: SettingsCategoryProps) {
  const { t } = useTranslation();
  const session = useSpeleoStore((s) => s.session);
  const setSession = useSpeleoStore((s) => s.setSession);
  const setSessionFromLogin = useSpeleoStore((s) => s.setSessionFromLogin);
  const clearSession = useSpeleoStore((s) => s.clearSession);

  const speleo = config.speleodb;

  // Live account form state — deliberately NOT part of the staged config diff.
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [useToken, setUseToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On mount, sync the session store from the backend (a rehydrated keychain
  // token means we're already logged in without re-prompting).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await invokeIpc<SpeleoSessionStatus>('speleodb_session');
        if (!cancelled) setSession(status);
      } catch {
        // Leave whatever the store had; the login form still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setSession]);

  // Login uses the endpoint currently staged above, so first-time setup works
  // before Save (the account email is persisted backend-side on success; the
  // endpoint persists when the dialog is saved).
  const endpointForLogin = (speleo.endpoint ?? '').trim() || undefined;

  const handleLogin = async () => {
    if (!useToken && !email.trim()) {
      setError(t('settings.speleodb.account.emailRequired'));
      return;
    }
    if (useToken ? !token.trim() : !password) {
      setError(
        useToken
          ? t('settings.speleodb.account.tokenRequired')
          : t('settings.speleodb.account.passwordRequired'),
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await invokeIpc<SpeleoLoginResult>('speleodb_login', {
        endpoint: endpointForLogin,
        email: useToken ? undefined : email.trim(),
        password: useToken ? undefined : password,
        token: useToken ? token.trim() : undefined,
      });
      setSessionFromLogin(result);
      setPassword('');
      setToken('');
    } catch (e) {
      setError(getErrorMessage(e, t('settings.speleodb.account.loginFailed')));
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    setBusy(true);
    setError(null);
    try {
      await invokeIpc<null>('speleodb_logout');
      clearSession();
      setEmail('');
      setPassword('');
      setToken('');
    } catch (e) {
      setError(getErrorMessage(e, t('settings.speleodb.account.logoutFailed')));
    } finally {
      setBusy(false);
    }
  };

  const handleEndpointChange = (v: string) =>
    onChange({ speleodb: { ...speleo, endpoint: v.length > 0 ? v : null } });
  const handleTokenFallbackChange = createSelectHandler(onChange, (v) => ({
    speleodb: { ...speleo, token_fallback: v as TokenFallback },
  }));
  const handleInsecureHttpToggle = createToggleHandler(onChange, (v) => ({
    speleodb: { ...speleo, insecure_http: v },
  }));

  const loggedIn = session?.loggedIn === true;
  // The 'unknown' sentinel normalizes to the secure default for display.
  const tokenFallbackValue = speleo.token_fallback === 'plaintext' ? 'plaintext' : 'session_only';

  return (
    <div
      role="tabpanel"
      id={getPanelId(panelIdBase, 'speleodb')}
      aria-labelledby={getTabId(panelIdBase, 'speleodb')}
      data-testid="settings-panel-speleodb"
    >
      <h2 className="text-lg font-medium mb-4">{t('settings.speleodb.title')}</h2>

      <SettingsSection
        title={t('settings.speleodb.sections.connection')}
        data-testid="section-speleodb-connection"
      >
        <SettingRow
          label={t('settings.speleodb.endpoint.label')}
          helpText={t('settings.speleodb.endpoint.help')}
          isChanged={isFieldChanged(changedFields, 'speleodb.endpoint')}
          onReset={() => onChange({ speleodb: { ...speleo, endpoint: defaultConfig.speleodb.endpoint } })}
          isDefault={speleo.endpoint === defaultConfig.speleodb.endpoint}
          data-testid="setting-speleodb-endpoint"
        >
          <input
            type="text"
            value={speleo.endpoint ?? ''}
            onChange={(e) => handleEndpointChange(e.target.value)}
            className="w-64 px-2 py-1 bg-background border border-border rounded text-sm"
            placeholder="https://www.speleodb.org/"
            aria-label={t('settings.speleodb.endpoint.aria')}
            data-testid="input-speleodb-endpoint"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.speleodb.tokenFallback.label')}
          helpText={t('settings.speleodb.tokenFallback.help')}
          isChanged={isFieldChanged(changedFields, 'speleodb.token_fallback')}
          onReset={() =>
            onChange({ speleodb: { ...speleo, token_fallback: defaultConfig.speleodb.token_fallback } })
          }
          isDefault={speleo.token_fallback === defaultConfig.speleodb.token_fallback}
          data-testid="setting-speleodb-token-fallback"
        >
          <Select
            value={tokenFallbackValue}
            onChange={handleTokenFallbackChange}
            options={[
              { value: 'session_only', label: t('settings.speleodb.tokenFallback.options.sessionOnly') },
              { value: 'plaintext', label: t('settings.speleodb.tokenFallback.options.plaintext') },
            ]}
            className="w-48"
            aria-label={t('settings.speleodb.tokenFallback.aria')}
            data-testid="select-speleodb-token-fallback"
          />
        </SettingRow>
        {speleo.token_fallback === 'plaintext' && (
          <div
            className="mb-2 p-3 bg-warning-20 text-warning rounded text-xs"
            data-testid="speleodb-plaintext-warning"
          >
            {t('settings.speleodb.tokenFallback.plaintextWarning')}
          </div>
        )}

        <SettingRow
          label={t('settings.speleodb.insecureHttp.label')}
          helpText={t('settings.speleodb.insecureHttp.help')}
          isChanged={isFieldChanged(changedFields, 'speleodb.insecure_http')}
          onReset={() =>
            onChange({ speleodb: { ...speleo, insecure_http: defaultConfig.speleodb.insecure_http } })
          }
          isDefault={speleo.insecure_http === defaultConfig.speleodb.insecure_http}
          data-testid="setting-speleodb-insecure-http"
        >
          <Toggle
            checked={speleo.insecure_http}
            onChange={handleInsecureHttpToggle}
            aria-label={t('settings.speleodb.insecureHttp.aria')}
            data-testid="toggle-speleodb-insecure-http"
          />
        </SettingRow>
        {speleo.insecure_http && (
          <div
            className="mb-2 p-3 bg-warning-20 text-warning rounded text-xs"
            data-testid="speleodb-insecure-http-warning"
          >
            {t('settings.speleodb.insecureHttp.warning')}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('settings.speleodb.sections.account')}
        data-testid="section-speleodb-account"
      >
        <p className="mb-3 text-xs text-text-secondary">
          {t('settings.speleodb.account.appliesImmediately')}
        </p>

        {error && (
          <div
            className="mb-3 p-3 bg-error-10 border border-error-20 rounded text-error text-sm"
            data-testid="speleodb-settings-error"
          >
            {error}
          </div>
        )}

        {loggedIn ? (
          <div className="space-y-2" data-testid="speleodb-account-signed-in">
            <p className="text-sm text-text-primary truncate">
              {t('settings.speleodb.account.signedInAs', { email: session?.userEmail ?? '' })}
            </p>
            {session && !session.keychainBacked && (
              <p className="text-xs text-warning" data-testid="speleodb-memory-only-warning">
                {t('settings.speleodb.account.memoryOnly')}
              </p>
            )}
            <Button onClick={handleLogout} disabled={busy} data-testid="speleodb-settings-logout">
              {busy ? t('settings.speleodb.account.loggingOut') : t('settings.speleodb.account.logout')}
            </Button>
          </div>
        ) : (
          <div className="space-y-3" data-testid="speleodb-account-login-form">
            {!useToken && (
              <div>
                <label className="block text-sm text-text-secondary mb-1">
                  {t('settings.speleodb.account.email')}
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-2 py-1 bg-background border border-border rounded text-sm"
                  data-testid="speleodb-settings-email"
                />
              </div>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={useToken}
                onChange={(e) => setUseToken(e.target.checked)}
                className="rounded"
                data-testid="speleodb-settings-use-token"
              />
              {t('settings.speleodb.account.useToken')}
            </label>
            {useToken ? (
              <div>
                <label className="block text-sm text-text-secondary mb-1">
                  {t('settings.speleodb.account.token')}
                </label>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  className="w-full px-2 py-1 bg-background border border-border rounded text-sm"
                  data-testid="speleodb-settings-token"
                />
              </div>
            ) : (
              <div>
                <label className="block text-sm text-text-secondary mb-1">
                  {t('settings.speleodb.account.password')}
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-2 py-1 bg-background border border-border rounded text-sm"
                  data-testid="speleodb-settings-password"
                />
              </div>
            )}
            <Button
              variant="primary"
              onClick={() => void handleLogin()}
              disabled={busy || (useToken ? !token.trim() : !email.trim())}
              data-testid="speleodb-settings-login"
            >
              {busy ? t('settings.speleodb.account.loggingIn') : t('settings.speleodb.account.login')}
            </Button>
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
