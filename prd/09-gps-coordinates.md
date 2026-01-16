# PRD: Add GPS Coordinates Input to Import Dialog

## Overview

**Task ID:** 9
**Priority:** High
**Phase:** 3 - GPS & Placement
**Estimated Complexity:** High

### Summary

Add GPS coordinate input supporting ALL formats (DD, DDM, DMS, UTM, MGRS, Plus Codes, What3words) with auto-detection, format hints, and API result caching.

## Background

GPS coordinates establish the real-world position of cave entrances (zero datum stations). Supporting multiple formats accommodates different GPS devices and data sources commonly used by cave surveyors.

## Requirements

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F1 | Single text input for GPS coordinates | Must |
| F2 | Auto-detect format on input/paste | Must |
| F3 | Support DD, DDM, DMS, UTM, MGRS formats | Must |
| F4 | Support Plus Codes via Google API | Must |
| F5 | Support What3words via W3W API | Must |
| F6 | Show parsed lat/long preview | Must |
| F7 | Show format hint for invalid input | Must |
| F8 | Cache API results for offline use | Must |
| F9 | GPS applies to zero datum station | Must |

### Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NF1 | Format detection should be instant for local formats | Must |
| NF2 | API calls should not block UI | Must |
| NF3 | Cache should persist across sessions | Should |

## User Decisions

- Auto-detect format on paste
- Invalid input: Show format hint (suggest closest matching format)
- GPS applies to zero datum station when created
- Cache API results (W3W, Plus Codes), configurable in Settings
- External APIs: OpenStreetMap for geocoding + official W3W API

## Technical Specification

### Files to Create/Modify

| File | Changes |
|------|---------|
| `src/utils/gps.ts` | New: GPS parsing and format detection |
| `src/components/Dialogs/ImportDialog.tsx` | Add GPS input section |
| `src/components/Dialogs/DmpImportDialog.tsx` | Add GPS input section |
| `src/types/config.ts` | Add GPS cache settings |

### Supported Formats

| Format | Example | Detection Pattern |
|--------|---------|-------------------|
| DD | `40.7128, -74.0060` | Two decimals with optional comma |
| DDM | `40° 42.768' N, 74° 0.360' W` | Degrees + decimal minutes + direction |
| DMS | `40° 42' 46.08" N, 74° 0' 21.6" W` | Degrees + minutes + seconds |
| UTM | `18T 583960 4507523` | Zone + easting + northing |
| MGRS | `18TWL8396007523` | Grid reference string |
| Plus Codes | `87G8Q2PQ+VP` | Plus code pattern |
| What3words | `filled.count.soap` | Three words with dots |

### Implementation Details

1. **GPS parser:**
   ```typescript
   // src/utils/gps.ts

   export interface ParsedCoordinates {
     lat: number;
     lng: number;
     format: GpsFormat;
     original: string;
   }

   export type GpsFormat = 'DD' | 'DDM' | 'DMS' | 'UTM' | 'MGRS' | 'PLUS_CODE' | 'W3W';

   export interface ParseResult {
     success: boolean;
     coordinates?: ParsedCoordinates;
     suggestedFormat?: GpsFormat;
     error?: string;
   }

   export const parseGpsInput = async (input: string): Promise<ParseResult> => {
     const trimmed = input.trim();

     // Try local formats first (instant)
     const localResult = parseLocalFormat(trimmed);
     if (localResult.success) return localResult;

     // Try Plus Codes
     if (isPlusCodePattern(trimmed)) {
       return await parsePlusCode(trimmed);
     }

     // Try What3words
     if (isW3WPattern(trimmed)) {
       return await parseW3W(trimmed);
     }

     // Suggest closest format
     return {
       success: false,
       suggestedFormat: detectClosestFormat(trimmed),
       error: 'Unable to parse coordinates',
     };
   };
   ```

2. **Local format parsers:**
   ```typescript
   const parseDD = (input: string): ParseResult => {
     // Match: 40.7128, -74.0060 or 40.7128 -74.0060
     const match = input.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
     if (!match) return { success: false };

     const lat = parseFloat(match[1]);
     const lng = parseFloat(match[2]);

     if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
       return { success: false, error: 'Coordinates out of range' };
     }

     return {
       success: true,
       coordinates: { lat, lng, format: 'DD', original: input },
     };
   };

   // Similar for DDM, DMS, UTM, MGRS...
   ```

3. **API integration with caching:**
   ```typescript
   const gpsCache = new Map<string, ParsedCoordinates>();

   const parseW3W = async (input: string): Promise<ParseResult> => {
     // Check cache first
     const cached = gpsCache.get(`w3w:${input}`);
     if (cached) return { success: true, coordinates: cached };

     try {
       const response = await fetch(
         `https://api.what3words.com/v3/convert-to-coordinates?words=${input}&key=${W3W_API_KEY}`
       );
       const data = await response.json();

       if (data.coordinates) {
         const coords: ParsedCoordinates = {
           lat: data.coordinates.lat,
           lng: data.coordinates.lng,
           format: 'W3W',
           original: input,
         };
         gpsCache.set(`w3w:${input}`, coords);
         persistCache(); // Save to localStorage
         return { success: true, coordinates: coords };
       }
     } catch (e) {
       return { success: false, error: 'W3W API unavailable' };
     }

     return { success: false, error: 'Invalid What3words address' };
   };
   ```

4. **UI component:**
   ```typescript
   const GpsInput: React.FC<{ onCoordinates: (coords: ParsedCoordinates) => void }> = ({
     onCoordinates
   }) => {
     const [input, setInput] = useState('');
     const [result, setResult] = useState<ParseResult | null>(null);
     const [loading, setLoading] = useState(false);

     const handleChange = async (value: string) => {
       setInput(value);
       if (!value.trim()) {
         setResult(null);
         return;
       }

       setLoading(true);
       const parseResult = await parseGpsInput(value);
       setResult(parseResult);
       setLoading(false);

       if (parseResult.success && parseResult.coordinates) {
         onCoordinates(parseResult.coordinates);
       }
     };

     return (
       <div>
         <label>GPS Coordinates (optional)</label>
         <input
           value={input}
           onChange={(e) => handleChange(e.target.value)}
           placeholder="40.7128, -74.0060 or Plus Code or What3words"
         />
         {loading && <Spinner size="sm" />}
         {result?.success && (
           <div className="text-green-500">
             ✓ {result.coordinates!.lat.toFixed(6)}, {result.coordinates!.lng.toFixed(6)}
             <span className="text-muted">({result.coordinates!.format})</span>
           </div>
         )}
         {result && !result.success && (
           <div className="text-yellow-500">
             {result.error}
             {result.suggestedFormat && (
               <span> Try format: {formatExamples[result.suggestedFormat]}</span>
             )}
           </div>
         )}
       </div>
     );
   };
   ```

## UI/UX Specification

### Input Section

```
GPS Coordinates (optional)
┌──────────────────────────────────────────────────────────┐
│ 40.7128, -74.0060                                        │
└──────────────────────────────────────────────────────────┘
✓ 40.712800, -74.006000 (DD - Decimal Degrees)
```

### Invalid Input

```
GPS Coordinates (optional)
┌──────────────────────────────────────────────────────────┐
│ 40 42 46 N                                               │
└──────────────────────────────────────────────────────────┘
⚠ Unable to parse. Try: 40° 42' 46" N, 74° 0' 21" W
```

### Loading State

```
GPS Coordinates (optional)
┌──────────────────────────────────────────────────────────┐
│ filled.count.soap                                    ⟳   │
└──────────────────────────────────────────────────────────┘
Looking up What3words...
```

### Settings UI

```
GPS Settings
├─ [x] Cache API results for offline use
├─ Cache duration: [30 days] ▼
└─ [Clear Cache] (X entries)
```

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Ambiguous format | Try all parsers, use first success |
| Lat/lng swapped | Detect by range (lat: -90..90) |
| API offline | Show error, use cache if available |
| Invalid W3W words | API returns error, display to user |
| Very precise coords | Preserve full precision internally |

## Testing

### Unit Tests

```typescript
// src/utils/__tests__/gps.test.ts
describe('GPS parsing', () => {
  it('parses DD format', () => {
    expect(parseDD('40.7128, -74.0060')).toMatchObject({
      success: true,
      coordinates: { lat: 40.7128, lng: -74.0060 }
    });
  });

  it('parses DDM format', () => {});
  it('parses DMS format', () => {});
  it('parses UTM format', () => {});
  it('parses MGRS format', () => {});
  it('suggests format for invalid input', () => {});
});
```

### Manual Tests

1. Enter DD coordinates, verify parsing
2. Paste DMS coordinates, verify auto-detection
3. Enter Plus Code, verify API call and caching
4. Enter What3words, verify API call
5. Go offline, verify cached coords work
6. Enter invalid input, verify format suggestion

## Dependencies

- OpenStreetMap/Nominatim for geocoding
- What3words API (requires API key)
- Google Plus Codes library or API

## Acceptance Criteria

- [ ] Single GPS input field in Import Dialog
- [ ] Auto-detects DD, DDM, DMS, UTM, MGRS formats
- [ ] Plus Codes resolved via API
- [ ] What3words resolved via W3W API
- [ ] Parsed lat/long preview displayed
- [ ] Invalid input shows format hint
- [ ] API results cached for offline use
- [ ] Cache configurable in Settings
- [ ] GPS applied to zero datum on section import
