import { useMemo, useState, useRef, useLayoutEffect, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { nextShotKind } from '../../utils/shotKind';
import { isEditingBlockedNow, useEditingBlocked } from '../../hooks/useEditingBlocked';
import { useDecimalPrecision } from '../../hooks/useDecimalPrecision';
import { SpreadsheetGrid, type GridColumn } from '../common/SpreadsheetGrid';
import { Select } from '../common/Select';
import { Button } from '../common/Button';
import { SectionMetadataForm } from '../common/SectionMetadataForm';
import { DialogWrapper } from '../Dialogs/DialogWrapper';
import { buildShotColumns } from './dataTableShotColumns';
import RawTableView from './RawTableView';
import { endDraft, materializeDraft, completeDraftData } from './dataTableDrafts';
import { buildShotUpdates } from './dataTableEdits';
import { invokeIpc, getErrorMessage } from '../../utils/ipc';
import type { Section, Shot, SectionData } from '../../types/project';
import type { CommandResult } from '../../types/commands';
import type { CellEdit } from '../common/SpreadsheetGrid/types';

interface Row extends Shot { sectionId: number }

/** Live survey data. Raw database inspection remains a separate read-only view. */
export function ProjectDataTable({ sections }: { sections: Section[] }) {
  const { t } = useTranslation();
  const precision = useDecimalPrecision();
  const blocked = useEditingBlocked();
  const store = useProjectStore();
  const [draft, setDraft] = useState(() => ({ ...endDraft(), data: useUIStore.getState().dataWorkspaceDraft?.data ?? {} }));
  const [draftSection, setDraftSection] = useState<number | null>(() => useUIStore.getState().dataWorkspaceDraft?.sectionId ?? null);
  const draftRef = useRef(draft);
  const draftSectionRef = useRef(draftSection);
  const mutationPending = useRef(false);
  const selection = useUIStore(state => state.selection);
  const [rawTables, setRawTables] = useState<string[]>([]);
  const [rawTable, setRawTable] = useState('');
  useEffect(() => {
    let cancelled = false;
    void invokeIpc<string[]>('get_raw_table_names').then(names => {
      if (cancelled || !Array.isArray(names)) return;
      setRawTables(names);
      setRawTable(current => names.includes(current) ? current : names.includes('shots') ? 'shots' : names[0] ?? '');
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [store.isDirty]);
  useEffect(() => {
    if (draftSection !== null && !sections.some(section => section.id === draftSection)) {
      draftSectionRef.current = null;
      setDraftSection(null);
      useUIStore.setState({ dataWorkspaceDraft: { data: draftRef.current.data, sectionId: null } });
    }
  }, [sections, draftSection]);
  const [view, setView] = useState('shots');
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
    checkResult(await store.createShot(sectionId, data));
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
  const openCreate = (row: Row | 'empty') => {
    setName(''); setSurveyor(''); setDate(''); setColor('#4ecdc4'); setDirection('in'); setError(null); setCreateFor(row);
  };
  const options = useMemo(() => [...sections.map(section => ({ value: String(section.id), label: section.name ?? t('sections.defaultName', { id: section.id }) })), { value: 'new', label: t('dataWorkspace.createSection') }], [sections, t]);
  const columns: GridColumn<Row>[] = useMemo(() => {
    const positions = new Map<string, number>(sections.flatMap(section => section.shots.map((shot, index) => [`${section.id}:${shot.id}`, index] as const)));
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
    return [
      { key: 'section', header: t('dataWorkspace.section'), width: 200, getValue: row => row.sectionId < 0 ? '' : row.sectionId,
        editable: !blocked && !busy, parse: () => undefined, noInlineEdit: true, activate: row => root.current?.querySelector<HTMLButtonElement>(`[data-testid="data-section-${row.id}"]`)?.click(),
        render: row => <Select variant="cell" value={String(row.sectionId)} options={options} disabled={blocked || busy || (row.id >= 0 && store.isShotFrozen(row.sectionId, positions.get(`${row.sectionId}:${row.id}`) ?? -1))} aria-label={t('dataWorkspace.section')} data-testid={`data-section-${row.id}`}
          onChange={value => { if (value === 'new') openCreate(row); else if (row.id < 0) { chooseDraftSection(Number(value)); void mutate(commitDraft); } else { void mutate(() => transfer(row, Number(value))); } }} /> },
      ...(['marker_index', 'temperature'] as const).map(key => ({ key, header: key === 'marker_index' ? t('dataWorkspace.markerIndex') : t('dataWorkspace.temperature'), width: 100, getValue: (row: Row) => row[key], editable: !blocked && !busy, kind: 'number-nullable' as const, validate: (value: unknown) => key === 'marker_index' && value !== null && (!Number.isInteger(value) || Number(value) < 0) ? t('dataWorkspace.integerRequired') : null })),
      ...forRow(sample).map((column): GridColumn<Row> => ({ ...column,
        isEditable: (row, index) => !busy && !blocked && (forRow(row).find(c => c.key === column.key)?.isEditable?.(row, index) ?? column.editable ?? false),
        ...(column.activate ? { activate: (row, index, direction) => forRow(row).find(c => c.key === column.key)?.activate?.(row, index, direction) } : {}),
        ...(column.render ? { render: (row, index) => forRow(row).find(c => c.key === column.key)?.render?.(row, index) } : {}),
      })),
    ];
  }, [rows, sections, t, precision, blocked, busy, store.warnings, options]);
  const edit = async (edits: CellEdit[]) => {
    if (blocked) return;
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
      if (!sections[row] || !['name', 'surveyor', 'date', 'color', 'direction', 'quality'].includes(colKey)) continue;
      const patch = updates.get(row) ?? {};
      patch[colKey] = ['name', 'surveyor', 'date'].includes(colKey) && value === '' ? null : value;
      updates.set(row, patch);
    }
    for (const [row, patch] of updates) {
      const section = sections[row];
      if (section) checkResult(await store.updateSection(section.id, patch));
    }
  };
  const sectionColumns: GridColumn<Section>[] = [
    { key: 'id', header: t('dataWorkspace.id'), getValue: row => row.id },
    ...(['name', 'surveyor', 'date', 'color', 'direction', 'quality'] as const).map(key => ({ key, header: key, getValue: (row: Section) => row[key], editable: !blocked && !busy, kind: key === 'quality' ? 'number' as const : 'text' as const })),
  ];
  return <div className="h-full" data-testid="data-table" data-fullscreen="true"><div className="h-full flex flex-col bg-panel" data-testid="project-data-table">
    <div className="flex items-center gap-3 p-2 border-b border-border">
      <Select value={view} onChange={setView} options={[{ value: 'shots', label: t('dataTable.viewShots') }, { value: 'sections', label: t('dataWorkspace.sections') }, { value: 'raw', label: t('dataWorkspace.inspector') }]} data-testid="project-data-view" />
      <Button size="sm" disabled={blocked || busy} onClick={() => openCreate('empty')} data-testid="data-create-section">{t('dataWorkspace.createSection')}</Button>
      {view === 'raw' && store.isDirty && <span data-testid="data-table-raw-dirty-hint">{t('dataTable.rawData.asOfLastSave')}</span>}
      {view === 'raw' && <Select data-testid="data-raw-table" value={rawTable} onChange={setRawTable} options={rawTables.map(value => ({ value, label: value }))} />}
      {error && <span role="alert" className="text-error">{error}</span>}
    </div>
    <div ref={root} className="flex-1 min-h-0">
      {view === 'raw' ? (rawTable ? <RawTableView tableName={rawTable} height={height} /> : <p>{t('dataWorkspace.saveToInspect')}</p>) : view === 'shots' ? <SpreadsheetGrid columns={columns} rows={rows} rowKey={row => `${row.sectionId}:${row.uuid ?? row.id}`} selectedRow={selection?.type === 'shot' ? rows.findIndex(row => row.sectionId === selection.sectionId && row.id === selection.shotId) : null} height={height} rowLabel={(_row, index) => index + 1}
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
