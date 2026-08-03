/**
 * The edit-section dialog's slice of {@link useGridViewPersistence}.
 *
 * Its own `panels` fields rather than sharing the new-section dialog's: the two
 * grids show different column sets (this one has no pitch columns and adds a
 * delete column), so one shared hidden list would let a key hidden in one view
 * govern the other.
 */
import {
  useGridViewPersistence,
  type GridViewSetters,
  type GridViewState,
} from './useGridViewPersistence';

export function useEditSectionViewPersistence(
  view: GridViewState,
  setters: GridViewSetters,
  fallbackHidden: readonly string[]
): void {
  useGridViewPersistence(view, setters, {
    orderField: 'edit_section_column_order',
    hiddenField: 'edit_section_hidden_columns',
    widthsField: 'edit_section_column_widths',
    command: 'update_edit_section_view',
    fallbackHidden,
    toastKey: 'edit-section-view-save',
  });
}
