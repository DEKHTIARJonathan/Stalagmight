import { useMemo, useState, useRef, useLayoutEffect, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { nextShotKind } from '../../utils/shotKind';
import { isEditingBlockedNow, useEditingBlocked } from '../../hooks/useEditingBlocked';
import { useDecimalPrecision } from '../../hooks/useDecimalPrecision';
import { SpreadsheetGrid, type GridColumn } from '../common/SpreadsheetGrid';
import { Select } from '../common/Select';
import { ShotFromIdInput } from './ShotFromIdInput';
import { Button } from '../common/Button';
import { Toggle } from '../common/Toggle';
import { SectionMetadataForm } from '../common/SectionMetadataForm';
import { DialogWrapper } from '../Dialogs/DialogWrapper';
import { buildShotColumns } from './dataTableShotColumns';
import { endDraft, materializeDraft, completeDraftData } from './dataTableDrafts';
import { buildShotUpdates } from './dataTableEdits';
import { invokeIpc, getErrorMessage } from '../../utils/ipc';
import type { Section, Shot, SectionData } from '../../types/project';
import type { CommandResult } from '../../types/commands';
import type { CellEdit } from '../common/SpreadsheetGrid/types';

interface Row extends Shot { sectionId: number; from_id?: number | null }

/** Live, editable survey shots and section metadata. */
export function ProjectDataTable({ sections }: { sections: Section[] }) {
  const { t, i18n } = useTranslation();
  const precision = useDecimalPrecision();
  const blocked = useEditingBlocked();
  const store = useProjectStore();
  const [draft, setDraft] = useState(() => ({ ...endDraft(), data: useUIStore.getState().dataWorkspaceDraft?.data ?? {} }));
  const [draftSection, setDraftSection] = useState<number | null>(() => useUIStore.getState().dataWorkspaceDraft?.sectionId ?? null);
  const draftRef = useRef(draft);
  const draftSectionRef = useRef(draftSection);
  const mutationPending = useRef(false);
  const selection = useUIStore(state => state.selection);
  useEffect(() => {
    if (draftSection !== null && !sections.some(section => section.id === draftSection)) {
      draftSectionRef.current = null;
      setDraftSection(null);
      useUIStore.setState({ dataWorkspaceDraft: { data: draftRef.current.data, sectionId: null } });
    }
  }, [sections, draftSection]);
  const [view, setView] = useState('shots');
  const [showInclinationLegs, setShowInclinationLegs] = useState(false);
  const [showAzimuthLegs, setShowAzimuthLegs] = useState(false);
  const [createFor, setCreateFor] = useState<Row | 'empty' | null>(null);
  const [name, setName] = useState('');
  const [surveyor, setSurveyor] = useState('');
  const [date, setDate] = useState('');
  const [color, setColor] = useState('#4ecdc4');
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(400);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const rows = useMemo(() => [...sections.flatMap(section => section.shots.map(shot => ({ ...shot, sectionId: section.id }))), { ...materializeDraft(draft), sectionId: draftSection ?? -1 }], [sections, draft, draftSection]);
  const report = (e: unknown) => setError(getErrorMessage(e));
  const checkResult = (result: CommandResult) => {
    if (!result.success) throw new Error(result.error ?? 'Unable to save changes');
  };
  const mutate = async (action: () => Promise<void>) => {
    if (mutationPending.current || isEditingBlockedNow()) return;
    mutationPending.current = true;
    setBusy(true);
    setError(null);
    try { await action(); } catch (error) { report(error); }
    finally { mutationPending.current = false; setBusy(false); }
  };
  const writeDraft = (next: typeof draft) => {
    draftRef.current = next;
    setDraft(next);
    useUIStore.setState({ dataWorkspaceDraft: { data: next.data, sectionId: draftSectionRef.current } });
  };
  const commitDraft = async () => {
    const data = completeDraftData(draftRef.current);
    const sectionId = draftSectionRef.current;
    if (!data || sectionId === null) return;
    checkResult(await store.createShot(sectionId, { ...data, from_id: draftRef.current.data.from_id ?? null }));
    writeDraft(endDraft());
  };
  const chooseDraftSection = (sectionId: number) => {
    draftSectionRef.current = sectionId;
    setDraftSection(sectionId);
    useUIStore.setState({ dataWorkspaceDraft: { data: draftRef.current.data, sectionId } });
  };
  const transfer = async (row: Row, target: number | null, newSection?: SectionData) => {
    const result = await invokeIpc<CommandResult>('reassign_shot', {
      sourceSectionId: row.sectionId, shotId: row.id,
      destinationSectionId: target, newSection: newSection ?? null,
    });
    if (!result.success) throw new Error(result.error ?? 'Unable to move shot');
    await store.refreshProjectState();
    store.markDirty();
    if (result.section_id !== undefined && result.shot_id !== undefined) {
      useUIStore.getState().setSelection({ type: 'shot', sectionId: result.section_id, shotId: result.shot_id });
    }
  };
  const setFromId = async (row: Row, fromId: number | null) => {
    if (row.id < 0) {
      writeDraft({ ...draftRef.current, data: { ...draftRef.current.data, from_id: fromId } });
      await commitDraft();
      return;
    }
    if (row.from_id === fromId) return;
    if (!row.number) throw new Error(t('dataWorkspace.missingShotNumber'));
    checkResult(await invokeIpc<CommandResult>('set_shot_from_id', { shotNumber: row.number, fromId }));
    await store.refreshProjectState();
    store.markDirty();
  };
  const shotNumbers = useMemo(() => new Set(sections.flatMap(section => section.shots.flatMap(shot => shot.number ? [shot.number] : []))), [sections]);
  const parseFromId = (value: unknown, row: Row): number | null => {
    const token = String(value ?? '').trim();
    if (token.toUpperCase() === 'NONE' || token === '-1') return null;
    const number = Number(token);
    if (!/^\d+$/.test(token) || !Number.isSafeInteger(number) || !shotNumbers.has(number) || number === row.number) {
      throw new Error(t('dataWorkspace.invalidOrigin'));
    }
    return number;
  };
  const openCreate = (row: Row | 'empty') => {
    setName(''); setSurveyor(''); setDate(''); setColor('#4ecdc4'); setDirection('in'); setError(null); setCreateFor(row);
  };
  const options = useMemo(() => {
    const collator = new Intl.Collator(i18n?.resolvedLanguage, { sensitivity: 'base', numeric: true });
    const existing = sections.map(section => ({ value: String(section.id), label: section.name ?? t('sections.defaultName', { id: section.id }) }));
    existing.sort((a, b) => collator.compare(a.label, b.label) || Number(a.value) - Number(b.value));
    return [{ value: 'new', label: t('dataWorkspace.createSection'), tone: 'success' as const, alwaysVisible: true }, ...existing];
  }, [sections, t, i18n?.resolvedLanguage]);
  const positions = useMemo(() => new Map<string, number>(sections.flatMap(section => section.shots.map((shot, index) => [`${section.id}:${shot.id}`, index] as const))), [sections]);
  const isLocked = (row: Row) => row.id >= 0 && store.isShotFrozen(row.sectionId, positions.get(`${row.sectionId}:${row.id}`) ?? -1);
  const lockMenuItems = ({ fromRow, toRow }: { fromRow: number; toRow: number }) => {
    if (blocked || busy) return [];
    const selected = rows.slice(fromRow, toRow + 1).filter(row => row.id >= 0 && row.number);
    const setLocked = (locked: boolean) => {
      void mutate(async () => {
        let changed = false;
        try {
          for (const row of selected) {
            if (isLocked(row) === locked) continue;
            checkResult(await invokeIpc<CommandResult>('set_shot_locked', { shotNumber: row.number, locked }));
            changed = true;
          }
        } finally {
          if (changed) { await store.refreshProjectState(); store.markDirty(); }
        }
      });
    };
    return [
      ...(selected.some(row => !isLocked(row)) ? [{ label: t('dataWorkspace.lockShot'), onClick: () => setLocked(true) }] : []),
      ...(selected.some(isLocked) ? [{ label: t('dataWorkspace.unlockShot'), onClick: () => setLocked(false) }] : []),
    ];
  };
  const columns: GridColumn<Row>[] = useMemo(() => {
    const cache = new Map<string, ReturnType<typeof buildShotColumns>>();
    const forRow = (row: Row) => {
      const key = `${row.sectionId}:${row.id}`;
      const cached = cache.get(key);
      if (cached) return cached;
      const result = buildShotColumns({
      t, precision, sectionId: row.sectionId, geometryReadOnly: blocked || busy,
      isShotFrozen: store.isShotFrozen,
      getShotWarnings: (sectionId, shotId) => store.warnings.filter(w => w.sectionId === sectionId && w.shotId === shotId),
      shotIndexAt: () => positions.get(key) ?? null,
      onCycleShotKind: (shot, direction) => {
        void mutate(async () => {
          const kind = nextShotKind(shot.kind, direction);
          if (shot.id < 0) {
            writeDraft({ ...draftRef.current, data: { ...draftRef.current.data, kind } });
            await commitDraft();
          } else checkResult(await store.setShotKind(row.sectionId, shot.id, kind));
        });
      },
      });
      cache.set(key, result);
      return result;
    };
    const sample = rows[0] ?? { sectionId: 0 } as Row;
    const columns: GridColumn<Row>[] = [
      { key: 'section', header: t('dataWorkspace.section'), width: 200, getValue: row => row.sectionId < 0 ? '' : row.sectionId,
        editable: !blocked && !busy, parse: () => undefined, noInlineEdit: true, activate: row => root.current?.querySelector<HTMLButtonElement>(`[data-testid="data-section-${row.id}"]`)?.click(),
        render: row => <Select variant="cell" fitContent dropdownRightMargin={100} searchLabel={t('dataWorkspace.searchSections')} noResultsLabel={t('dataWorkspace.noSections')} value={String(row.sectionId)} options={options} disabled={blocked || busy || (row.id >= 0 && store.isShotFrozen(row.sectionId, positions.get(`${row.sectionId}:${row.id}`) ?? -1))} aria-label={t('dataWorkspace.section')} data-testid={`data-section-${row.id}`}
          onChange={value => { if (value === 'new') openCreate(row); else if (row.id < 0) { chooseDraftSection(Number(value)); void mutate(commitDraft); } else { void mutate(() => transfer(row, Number(value))); } }} /> },
      ...forRow(sample).map((column): GridColumn<Row> => ({ ...column,
        isEditable: (row, index) => !busy && !blocked && (forRow(row).find(c => c.key === column.key)?.isEditable?.(row, index) ?? column.editable ?? false),
        ...(column.activate ? { activate: (row, index, direction) => forRow(row).find(c => c.key === column.key)?.activate?.(row, index, direction) } : {}),
        ...(column.render ? { render: (row, index) => forRow(row).find(c => c.key === column.key)?.render?.(row, index) } : {}),
      })),
    ];
    columns.push({
      key: 'from_id', header: t('dataWorkspace.fromId'), width: 140, editable: !blocked && !busy,
      isEditable: row => !blocked && !busy && (row.id < 0 || (!!row.number && !store.isShotFrozen(row.sectionId, positions.get(`${row.sectionId}:${row.id}`) ?? -1))),
      noInlineEdit: true, parse: () => undefined,
      getValue: row => row.from_id ?? null,
      format: value => value === null ? 'NONE' : String(value),
      activate: row => root.current?.querySelector<HTMLInputElement>(`[data-testid="data-from-id-${row.id}"]`)?.focus(),
      render: row => <ShotFromIdInput fromId={row.id < 0 ? draftRef.current.data.from_id ?? null : row.from_id ?? null}
        parseValue={value => parseFromId(value, row)} onInvalid={report} testId={`data-from-id-${row.id}`}
        disabled={blocked || busy || (row.id >= 0 && (!row.number || store.isShotFrozen(row.sectionId, positions.get(`${row.sectionId}:${row.id}`) ?? -1)))}
        onChange={value => { void mutate(() => setFromId(row, value)); }} />,
    });
    const leading = ['_warnings', 'shot_id', 'section', 'from_id'];
    return [...leading.flatMap(key => columns.filter(column => column.key === key)), ...columns.filter(column => !leading.includes(column.key))]
      .filter(column => (showInclinationLegs || !['pitch_in', 'pitch_out'].includes(column.key))
        && (showAzimuthLegs || !['azimuth_in', 'azimuth_out'].includes(column.key)));
  }, [rows, positions, t, precision, blocked, busy, store.warnings, options, shotNumbers, showInclinationLegs, showAzimuthLegs]);
  const edit = async (edits: CellEdit[]) => {
    if (blocked) return;
    const originEdits = edits.filter(edit => edit.colKey === 'from_id');
    if (originEdits.length) {
      if (edits.length !== 1) throw new Error(t('dataWorkspace.singleOriginEdit'));
      const row = rows[originEdits[0]!.row];
      if (row) {
        // Spreadsheet deletion clears an origin; typed values use explicit NONE.
        const value = originEdits[0]!.value;
        const fromId = value == null || value === '' ? null : parseFromId(value, row);
        await setFromId(row, fromId);
      }
      return;
    }
    const groups = new Map<number, CellEdit[]>();
    for (const item of edits) groups.set(item.row, [...(groups.get(item.row) ?? []), item]);
    const draftEdits = edits.filter(item => (rows[item.row]?.id ?? 0) < 0);
    if (draftEdits.length) {
      const current = draftRef.current;
      writeDraft({ ...current, data: { ...current.data, ...buildShotUpdates(materializeDraft(current), draftEdits) } });
    }
    const commands = [...groups].flatMap(([index, changes]) => {
      const row = rows[index];
      return row && row.id >= 0 ? [{ type: 'update_shot' as const, section_id: row.sectionId, shot_id: row.id, updates: buildShotUpdates(row, changes) }] : [];
    });
    if (commands.length) checkResult(await store.executeBatch(commands));
    await commitDraft();
  };
  const saveSection = async () => {
    if (!createFor) return;
    await mutate(async () => {
      const data: SectionData = { name: name || null, surveyor: surveyor || null, date: date || null, color, direction, quality: 1, shots: [] };
      if (createFor === 'empty' || createFor.id < 0) {
        const result = await store.createSection(data);
        if (!result.success) throw new Error(result.error ?? 'Unable to create section');
        if (result.section_id !== undefined) chooseDraftSection(result.section_id);
        if (result.section_id !== undefined) useUIStore.getState().setSelection({ type: 'section', sectionId: result.section_id });
      } else await transfer(createFor, null, data);
      setCreateFor(null);
    });
  };
  const editSections = async (edits: CellEdit[]) => {
    const updates = new Map<number, Record<string, unknown>>();
    for (const { row, colKey, value } of edits) {
      if (!sections[row] || !['name', 'explorer', 'surveyor', 'date', 'color', 'direction', 'quality'].includes(colKey)) continue;
      const patch = updates.get(row) ?? {};
      if (colKey === 'color' && (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))) throw new Error(t('dataWorkspace.invalidColor'));
      patch[colKey] = ['name', 'explorer', 'surveyor', 'date'].includes(colKey) && value === '' ? null : value;
      updates.set(row, patch);
    }
    for (const [row, patch] of updates) {
      const section = sections[row];
      if (section) checkResult(await store.updateSection(section.id, patch));
    }
  };
  const sectionColumns: GridColumn<Section>[] = [
    ...(['name', 'explorer', 'surveyor', 'date'] as const).map(key => ({ key, header: t(`dataWorkspace.sectionColumns.${key}`), getValue: (row: Section) => row[key] ?? '', editable: !blocked && !busy, kind: 'text' as const })),
    {
      key: 'color', header: t('dataWorkspace.sectionColumns.color'), width: 130,
      getValue: section => section.color, editable: !blocked && !busy, noInlineEdit: true,
      activate: section => root.current?.querySelector<HTMLInputElement>(`[data-testid="data-section-color-${section.id}"]`)?.click(),
      render: section => <label className="relative flex min-w-0 items-center gap-2 cursor-pointer focus-within:ring-1 focus-within:ring-accent">
        <span className="h-4 w-4 shrink-0 rounded border border-border" style={{ backgroundColor: section.color }} aria-hidden="true" />
        <span className="font-mono uppercase">{section.color}</span>
        <input type="color" value={section.color} disabled={blocked || busy} aria-label={t('dataWorkspace.chooseColor', { name: section.name ?? t('sections.defaultName', { id: section.id }) })} data-testid={`data-section-color-${section.id}`}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
          onChange={event => { const value = event.target.value; void mutate(() => editSections([{ row: sections.findIndex(row => row.id === section.id), colKey: 'color', value }])); }} />
      </label>,
    },
    ...(['direction', 'quality'] as const).map(key => ({ key, header: t(`dataWorkspace.sectionColumns.${key}`), getValue: (row: Section) => row[key], editable: !blocked && !busy, kind: key === 'quality' ? 'number' as const : 'text' as const })),
  ];
  return <div className="h-full" data-testid="data-table" data-fullscreen="true"><div className="h-full flex flex-col bg-panel" data-testid="project-data-table">
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 p-2 border-b border-border">
      <div className="min-w-0">
        <Button size="sm" disabled={blocked || busy} onClick={() => openCreate('empty')} data-testid="data-create-section">{t('dataWorkspace.createSection')}</Button>
      </div>
      <div role="tablist" aria-label={t('dataWorkspace.tableSelector')} className="flex overflow-hidden rounded border border-border" data-testid="project-data-view"
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 'shots' : event.key === 'End' ? 'sections' : view === 'shots' ? 'sections' : 'shots';
          setView(next);
          document.getElementById(`project-data-${next}-tab`)?.focus();
        }}>
        {(['shots', 'sections'] as const).map(table => <button key={table} type="button" role="tab" aria-selected={view === table} tabIndex={view === table ? 0 : -1} aria-controls={`project-data-${table}-panel`} id={`project-data-${table}-tab`} data-testid={`project-data-view-${table}`}
          className={`px-3 py-1 text-sm ${view === table ? 'bg-accent text-accent-on' : 'text-text-secondary hover:bg-accent-10'}`}
          onClick={() => setView(table)}>{table === 'shots' ? t('dataTable.viewShots') : t('dataWorkspace.sections')}</button>)}
      </div>
      <div className="min-w-0 flex flex-wrap items-center justify-end gap-x-4 gap-y-2 text-xs">
        {view === 'shots' && <>
          <div className="inline-flex items-center gap-2">
            <Toggle checked={showInclinationLegs} onChange={setShowInclinationLegs} label={t('dataWorkspace.inclinationLegs')} data-testid="data-toggle-inclination-legs" />
            <span aria-hidden="true">{showInclinationLegs ? 'ON' : 'OFF'}</span>
          </div>
          <div className="inline-flex items-center gap-2">
            <Toggle checked={showAzimuthLegs} onChange={setShowAzimuthLegs} label={t('dataWorkspace.azimuthLegs')} data-testid="data-toggle-azimuth-legs" />
            <span aria-hidden="true">{showAzimuthLegs ? 'ON' : 'OFF'}</span>
          </div>
        </>}
      </div>
    </div>
    {error && <p role="alert" className="px-2 py-1 text-xs text-error">{error}</p>}
    <div ref={root} className="flex-1 min-h-0" role="tabpanel" id={`project-data-${view}-panel`} aria-labelledby={`project-data-${view}-tab`}>
      {view === 'shots' ? <SpreadsheetGrid columns={columns} rows={rows} rowKey={row => `${row.sectionId}:${row.uuid ?? row.id}`} selectedRow={selection?.type === 'shot' ? rows.findIndex(row => row.sectionId === selection.sectionId && row.id === selection.shotId) : null} height={height} rowLabel={(_row, index) => index + 1}
        rowClassName={row => isLocked(row) ? 'sg-row-frozen' : undefined} extraContextMenuItems={lockMenuItems}
        onEdit={(row, colKey, value) => { void mutate(() => edit([{ row, colKey, value }])); }} onBatchEdit={edits => { void mutate(() => edit(edits)); }} />
        : <SpreadsheetGrid columns={sectionColumns} rows={sections} rowKey={row => row.id} height={height} onEdit={(row, colKey, value) => { void mutate(() => editSections([{ row, colKey, value }])); }} onBatchEdit={edits => { void mutate(() => editSections(edits)); }} />}
    </div>
    {createFor && <DialogWrapper title={t('dataWorkspace.createSection')} onClose={() => { if (!busy) setCreateFor(null); }}>
      <SectionMetadataForm name={name} surveyor={surveyor} date={date} color={color} direction={direction} showDirection disabled={busy || blocked} onNameChange={setName} onSurveyorChange={setSurveyor} onDateChange={setDate} onColorChange={setColor} onDirectionChange={setDirection} />
      {error && <p role="alert">{error}</p>}
      <Button variant="primary" disabled={busy || blocked} onClick={() => { void saveSection(); }} data-testid="data-save-section">{t('common.actions.save')}</Button>
    </DialogWrapper>}
  </div></div>;
}
