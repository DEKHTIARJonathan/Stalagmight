/**
 * Persist the new-section dialog's grid layout (column order, visibility,
 * widths) in the app config. Init once when the config arrives; later changes
 * save debounced.
 *
 * A slimmed `useDataTableViewPersistence` over three fields, keeping the four
 * behaviours that file paid for in bugs (#357):
 *   - a SORTED snapshot (`stableWidths`, `.sort()`ed hidden list), so merely
 *     opening the dialog does not schedule a save of state nobody touched;
 *   - an optimistic publish into the in-memory config BEFORE the IPC, so a
 *     remount that races the flush seeds from the fresh values;
 *   - rollback + a toast when the IPC rejects, so a later change retries instead
 *     of the layout silently reverting on next launch;
 *   - a mount-only cleanup that flushes a still-pending save on unmount.
 *
 * That last one matters more here than in the data table: this dialog unmounts
 * on every Create and every Cancel, which is almost always inside the 500 ms
 * debounce window of whatever the user last resized.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { invokeIpc } from '../../utils/ipc';
import { stableWidths } from '../SingleSystemView/useDataTableViewPersistence';

/** The layout the dialog owns and hands in. */
export interface NewSectionViewState {
  columnOrder: string[];
  hiddenColumns: ReadonlySet<string>;
  columnWidths: Record<string, number>;
}

/** Setters used to hydrate {@link NewSectionViewState} on the one-shot seed. */
export interface NewSectionViewSetters {
  setColumnOrder: (order: string[]) => void;
  setHiddenColumns: (cols: ReadonlySet<string>) => void;
  setColumnWidths: (widths: Record<string, number>) => void;
}

export function useNewSectionViewPersistence(
  view: NewSectionViewState,
  setters: NewSectionViewSetters
): void {
  const { t } = useTranslation();
  const showToast = useUIStore((s) => s.showToast);
  const panelsConfig = useProjectStore((s) => s.config?.panels);

  const { columnOrder, hiddenColumns, columnWidths } = view;
  const { setColumnOrder, setHiddenColumns, setColumnWidths } = setters;

  const lastSavedRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastSavedRef.current !== null || !panelsConfig) return;
    // `?? []` / `?? {}` because panelsConfig comes straight from get_config with
    // no defaultConfig merge: the only guarantee is the Rust #[serde(default)],
    // so a frontend running against a backend that predates these fields would
    // otherwise take the dialog down on open. The persisted list is
    // authoritative once present - an EMPTY hidden array genuinely means the
    // user unhid every column, and must not be re-defaulted or that preference
    // could never persist.
    const order = panelsConfig.new_section_column_order ?? [];
    const hidden = panelsConfig.new_section_hidden_columns ?? [];
    const widths = panelsConfig.new_section_column_widths ?? {};
    setColumnOrder(order);
    setHiddenColumns(new Set(hidden));
    setColumnWidths(widths);
    // Sorted here because the save snapshot below sorts, and the two strings are
    // compared verbatim - the default hidden list is not already sorted, so
    // without this merely OPENING the dialog would schedule a save.
    lastSavedRef.current = JSON.stringify([order, [...hidden].sort(), stableWidths(widths)]);
  }, [panelsConfig, setColumnOrder, setHiddenColumns, setColumnWidths]);

  const pendingSaveRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (lastSavedRef.current === null) return undefined;
    const hidden = [...hiddenColumns].sort();
    const snapshot = JSON.stringify([columnOrder, hidden, stableWidths(columnWidths)]);
    if (snapshot === lastSavedRef.current) {
      pendingSaveRef.current = null;
      return undefined;
    }
    const save = () => {
      pendingSaveRef.current = null;
      const previouslySaved = lastSavedRef.current;
      lastSavedRef.current = snapshot;
      // Deliberately `setState`, NOT the `setConfig` action: that one is the
      // whole-config REPLACEMENT path and also nulls the adjusted-geometry
      // caches, which nothing under `[panels]` invalidates.
      const config = useProjectStore.getState().config;
      if (config) {
        useProjectStore.setState({
          config: {
            ...config,
            panels: {
              ...config.panels,
              new_section_column_order: columnOrder,
              new_section_hidden_columns: hidden,
              new_section_column_widths: columnWidths,
            },
          },
        });
      }
      void invokeIpc(
        'update_new_section_view',
        { columnOrder, hiddenColumns: hidden, columnWidths },
        { purpose: 'persist new-section grid view state' }
      )
        .then(() => useProjectStore.getState().loadConfig())
        .catch((e) => {
          if (lastSavedRef.current === snapshot) {
            lastSavedRef.current = previouslySaved;
            // Undo the optimistic publish from DISK, so a remount cannot seed
            // from values that never landed and treat them as saved.
            void useProjectStore.getState().loadConfig();
          }
          console.error('Failed to save new-section view state:', e);
          showToast(t('dataTable.viewSaveFailed'), 'new-section-view-save', 'error');
        });
    };
    pendingSaveRef.current = save;
    const timer = setTimeout(save, 500);
    return () => clearTimeout(timer);
  }, [showToast, t, columnOrder, hiddenColumns, columnWidths]);

  // Flush a still-pending save on unmount. The cleanup above is clearTimeout
  // only and runs on every dep change too, so it cannot tell unmount apart; a
  // mount-only effect can.
  useEffect(
    () => () => {
      pendingSaveRef.current?.();
    },
    []
  );
}
