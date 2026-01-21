/**
 * Custom DatePicker component using react-datepicker with dark theme styling.
 * Replaces native HTML date input which has issues in Tauri/WebView.
 */
import ReactDatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';

interface DatePickerProps {
  /** Currently selected date (YYYY-MM-DD format) */
  value: string;
  /** Callback when date changes */
  onChange: (value: string) => void;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Placeholder text */
  placeholder?: string;
  /** Test ID for E2E tests */
  'data-testid'?: string;
}

/**
 * Parse a YYYY-MM-DD string to a Date object.
 * Returns null if the string is empty or invalid.
 */
function parseDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  const date = new Date(dateStr + 'T00:00:00');
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Format a Date object to YYYY-MM-DD string.
 */
function formatDate(date: Date | null): string {
  if (!date) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function DatePicker({
  value,
  onChange,
  disabled = false,
  placeholder = 'Select date',
  'data-testid': testId,
}: DatePickerProps) {
  const selectedDate = parseDate(value);

  const handleChange = (date: Date | null) => {
    onChange(formatDate(date));
  };

  return (
    <div className="w-full" data-testid={testId}>
      <ReactDatePicker
        selected={selectedDate}
        onChange={handleChange}
        dateFormat="yyyy-MM-dd"
        placeholderText={placeholder}
        disabled={disabled}
        className="w-full px-3 py-2 bg-background border border-border rounded text-foreground disabled:opacity-50"
        calendarClassName="dark-calendar"
        wrapperClassName="w-full"
        popperClassName="dark-popper"
        showPopperArrow={false}
      />
    </div>
  );
}
