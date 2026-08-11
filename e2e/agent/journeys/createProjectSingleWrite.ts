/**
 * create-project-single-write: the deliberate-save-path creation contract,
 * ported from the retired WDIO `save-now-single-write` spec (#549). Creating a
 * project WITH an explicit save path must be a single write: one
 * `createProject` call carrying the path, no `saveProject` action AND no
 * `save_project` IPC (counted at the invoke layer, so a store-internal
 * create-then-save cannot hide), and the project's `file_path` plus the file
 * on disk coming out of that one call. This pins the STORE contract; the
 * New Project dialog's use of it is Playwright's to cover.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Journey } from './framework';
import { hasProject } from '../scenarios/common';

interface SingleWriteProbe {
  ok: boolean;
  error?: string;
  createResult?: { success?: boolean; error?: string | null };
  counts?: { createProject: number; saveProject: number; saveIpc: number };
  filePath?: string | null;
}

export const createProjectSingleWrite: Journey = {
  name: 'create-project-single-write',
  description: 'Create with an explicit save path: one createProject call, zero saveProject calls.',
  async run(ctx) {
    if (await hasProject(ctx)) {
      await ctx.callAction('project', 'closeProject', []).catch(() => undefined);
    }

    const savePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'journey-single-write-')),
      'single-write.stalx',
    );

    // Spy, drive, and restore in ONE eval so the store never escapes the run
    // with wrapped actions installed, whatever the create does.
    const probe = await ctx.eval<SingleWriteProbe>(
      `
      const store = window.__E2E_TEST__ && window.__E2E_TEST__.projectStore;
      if (!store) return { ok: false, error: 'E2E project store not available' };
      const tauriCore = window.__TAURI__ && window.__TAURI__.core;
      if (!tauriCore) return { ok: false, error: '__TAURI__.core not available' };
      const originalCreate = store.getState().createProject;
      const originalSave = store.getState().saveProject;
      const originalInvoke = tauriCore.invoke;
      let createCalls = 0;
      let saveCalls = 0;
      let saveIpcCalls = 0;
      store.setState({
        createProject: async (...a) => { createCalls += 1; return originalCreate(...a); },
        saveProject: async (...a) => { saveCalls += 1; return originalSave(...a); },
      });
      // The IPC layer too: a store-internal invokeIpc('save_project') would
      // never touch the saveProject action, so the action spy alone is blind
      // to it.
      tauriCore.invoke = (cmd, ...rest) => {
        if (cmd === 'save_project') saveIpcCalls += 1;
        return originalInvoke.call(tauriCore, cmd, ...rest);
      };
      try {
        const createResult = await store.getState().createProject(
          'Journey Single Write',
          undefined,
          { savePath: args[0] },
        );
        const project = store.getState().project;
        return {
          ok: true,
          createResult,
          counts: { createProject: createCalls, saveProject: saveCalls, saveIpc: saveIpcCalls },
          filePath: project ? project.file_path : null,
        };
      } catch (error) {
        return {
          ok: false,
          error: String(error),
          counts: { createProject: createCalls, saveProject: saveCalls, saveIpc: saveIpcCalls },
        };
      } finally {
        store.setState({ createProject: originalCreate, saveProject: originalSave });
        tauriCore.invoke = originalInvoke;
      }
      `,
      [savePath],
    );
    await ctx.checkpoint('after-create');

    try {
      if (!probe.ok) {
        throw new Error(`single-write probe failed: ${probe.error ?? 'unknown'}`);
      }
      ctx.expect('create with explicit path reported success',
        probe.createResult?.success === true,
        `error=${probe.createResult?.error ?? 'none'}`);
      ctx.expect('exactly one createProject call',
        probe.counts?.createProject === 1,
        `createProject calls=${probe.counts?.createProject}`);
      ctx.expect('saveProject was never called - the create IS the write',
        probe.counts?.saveProject === 0,
        `saveProject calls=${probe.counts?.saveProject}`);
      ctx.expect('no save_project IPC either - the action spy cannot be bypassed',
        probe.counts?.saveIpc === 0,
        `save_project IPC calls=${probe.counts?.saveIpc}`);
      ctx.expect('the project holds the chosen path',
        probe.filePath === savePath,
        `file_path=${probe.filePath ?? 'null'} expected=${savePath}`);
      ctx.expect('the single write landed on disk',
        fs.existsSync(savePath),
        `nothing at ${savePath}`);
    } finally {
      // Close before removing the file: deleting a live SQLite database under
      // the backend's open handle is the SIGBUS hazard the harness documents.
      await ctx.callAction('project', 'closeProject', []).catch(() => undefined);
      fs.rmSync(path.dirname(savePath), { recursive: true, force: true });
    }
  },
};
