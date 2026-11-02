import type { MockCommandFamily } from './types';

/**
 * SpeleoDB commands of the Playwright IPC mock: deterministic logged-out / local defaults.
 *
 * Split out of `../tauri-ipc.ts` unchanged (#576 E8). Runs IN THE PAGE: `setupTauriMocks`
 * serializes this factory with `Function.prototype.toString` into its init script, so it
 * may use only `ctx` and browser globals - never an import (type-only imports are erased).
 */
export const speleodbCommands: MockCommandFamily = (ctx) => {
  return (cmd, args) => {
    switch (cmd) {
      // SpeleoDB (#203/#204/#205): deterministic logged-out / local defaults so
      // the settings tab + browser render without a live server. No e2e spec
      // drives the hand-off yet; these keep the mounts from erroring on null.
      case 'speleodb_session':
        return {
          logged_in: false,
          user_email: null,
          endpoint: null,
          keychain_backed: false,
          // No login this session, so nothing has touched the keychain - which
          // is exactly what the UI must be able to say without probing.
          storage: null,
          keychain: 'not_attempted',
        };
      // The credential-storage verbs both answer with a refreshed session. A
      // mocked run is signed out, so they echo the logged-out shape above
      // rather than inventing a session the rest of the mock does not have.
      case 'speleodb_set_token_storage':
      case 'speleodb_retry_keychain':
        return {
          logged_in: false,
          user_email: null,
          endpoint: null,
          keychain_backed: false,
          storage: null,
          keychain: 'not_attempted',
        };
      case 'speleodb_link_status':
        // Full SpeleoLinkStatus shape (remote_state / access_denied / server_error
        // included) so a spec that flips is_remote:true still matches the DTO.
        return {
          is_remote: false,
          edit_enabled: true,
          has_unpushed_edits: false,
          permission: null,
          lock_holder: null,
          remote_state: 'unknown',
          access_denied: false,
          server_error: null,
          exclude_geojson: false,
          // [#303] Dirty ONLY because a chain step walked this copy back to an older
          // revision - the user has edited nothing. Every consumer composes it with
          // has_unpushed_edits (`isUnwoundNotEdited`), and it is what makes the close
          // and quit prompts stop calling an old copy "unpushed changes" and stop
          // pre-focusing the push. It was missing here, so it read as `undefined`
          // rather than false and no spec could reach the state at all - the state
          // this whole feature is built around.
          unwound: false,
          // [#303] The hybrid undo stack's policy fields. Full is the default, and
          // not overridden, so the settings control renders "following the global
          // default" - the shape a spec sees unless it overrides this.
          undo_mode: 'full',
          undo_mode_overridden: false,
          // A spec opts into a different link state by assigning this before the app
          // asks; anything it carries wins over the defaults above.
          ...((window as unknown as Record<string, unknown>)
            .__speleoLinkStatusOverrides as Record<string, unknown> | undefined),
        };
      case 'speleodb_list_projects':
        return [];
      // #270: local (un-pushed) state per project id, keyed by id. Nothing is
      // cached in a mocked run, so every list renders without a local-edit
      // accent; specs that need one override this per spec.
      case 'speleodb_local_project_states':
        return {};
      case 'speleodb_take_remote':
        // Returns the reloaded .stalx path (#198); no e2e spec drives it yet.
        return '/mock/project.stalx';
      case 'speleodb_logout':
      case 'speleodb_unlink':
      // Strip half of the managed-file prompt: deletes a foreign copy's
      // speleo_link row. No payload; specs assert the invocation itself.
      case 'speleodb_remove_link_at':
      case 'speleodb_release_all_locks':
      case 'speleodb_release_lock':
      // [#258 review] The provenance-scoped unwind. No payload, and no argument:
      // it releases whatever THIS process recorded acquiring, or nothing.
      case 'speleodb_release_lock_acquired_here':
      case 'speleodb_set_exclude_geojson':
      // [#303] The per-project undo-history policy write: no payload. The FE
      // re-reads `speleodb_link_status` afterwards for the new value.
      case 'speleodb_set_undo_mode':
      // #215 lock release + delete: no payload.
      case 'speleodb_release_current_lock':
      case 'speleodb_delete_project':
        return null;
      // [#303] Which revision a chain step would load, backward and forward. `null`
      // by default - a mocked project has no revision history to walk - so neither
      // dropdown shows its step entry unless a spec overrides this.
      case 'speleodb_unwind_target':
      case 'speleodb_rewind_target':
        return null;
      // [#303] Discard the local copy and re-lock. Mocked as a plain successful
      // acquire: the specs that reach it care that the app returns to an editing
      // state, not about the download it does on the way.
      case 'speleodb_discard_changes':
        return { kind: 'editing' };
      // #215 collaborator management: the roster (users + teams). The mutating
      // commands echo the refreshed roster; the picker lists no teams by default.
      case 'speleodb_list_collaborators':
      case 'speleodb_add_collaborator':
      case 'speleodb_set_collaborator':
      case 'speleodb_remove_collaborator':
      case 'speleodb_add_team':
      case 'speleodb_set_team':
      case 'speleodb_remove_team':
        return { users: [], teams: [] };
      case 'speleodb_list_teams':
        return [];
      case 'speleodb_search_users':
        return [];
      case 'speleodb_get_project_metadata':
      case 'speleodb_patch_project':
        // Deterministic project metadata for the #206 settings tab. patch echoes
        // the same shape (a real server would return post-edit truth).
        return {
          name: 'Mock Cave',
          description: '',
          country: 'US',
          visibility: 'PRIVATE',
          latitude: null,
          longitude: null,
          exclude_geojson: false,
        };
      case 'speleodb_publish':
        // #207 publish result: the reloaded (now-remote) local .stalx path.
        return {
          project_id: 'mock-project-id',
          endpoint: 'https://speleodb.example',
          local_path: '/mock/project.stalx',
        };
      case 'speleodb_login':
        return {
          user_email: 'test@example.com',
          endpoint: 'https://speleodb.example',
          keychain_backed: true,
          storage: 'keychain',
          keychain: 'available',
          needs_storage_choice: false,
        };

      default:
        return ctx.unhandled;
    }
  };
};
