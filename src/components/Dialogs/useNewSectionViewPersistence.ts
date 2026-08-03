/**
 * The new-section dialog's slice of {@link useGridViewPersistence}.
 *
 * A thin wrapper rather than its own copy: the seed/snapshot/debounce/rollback
 * machinery is subtle enough that a second copy would be free to drift, and
 * there are now three grids persisting a column layout.
 */
import {
  useGridViewPersistence,
  type GridViewSetters,
  type GridViewState,
} from './useGridViewPersistence';

export type NewSectionViewState = GridViewState;
export type NewSectionViewSetters = GridViewSetters;

export function useNewSectionViewPersistence(
  view: NewSectionViewState,
  setters: NewSectionViewSetters,
  /** Hidden set for a config that has never stored one. */
  fallbackHidden: readonly string[]
): void {
  useGridViewPersistence(view, setters, {
    orderField: 'new_section_column_order',
    hiddenField: 'new_section_hidden_columns',
    widthsField: 'new_section_column_widths',
    command: 'update_new_section_view',
    fallbackHidden,
    toastKey: 'new-section-view-save',
  });
}
