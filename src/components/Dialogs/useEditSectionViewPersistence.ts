/**
 * The edit-section dialog's slice of {@link useGridViewPersistence}.
 *
 * Its own `panels` fields rather than sharing the new-section dialog's. The two
 * grids now have the SAME columns, so the reason is not the column set - it is
 * that they are different jobs. Entering a brand-new section starts simple
 * (length, one azimuth, both depths); correcting a survey that already exists
 * opens on everything it has. One shared hidden list would collapse those into
 * each other, so narrowing the entry form would narrow the review form too.
 *
 * Do not merge them on the grounds that the defaults have converged.
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
