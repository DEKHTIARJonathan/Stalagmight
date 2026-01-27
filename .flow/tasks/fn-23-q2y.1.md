# fn-23-q2y.1 Create shared tile config utility and refactor MapCanvas

## Description

Create a shared tile configuration utility and refactor MapCanvas to use it instead of its inline `getSatelliteTileConfig` callback.

**Size:** M
**Files:** `src/utils/tileConfig.ts` (new), `src/utils/tileConfig.test.ts` (new), `src/components/Map/MapCanvas.tsx`

## Approach

- Create `src/utils/tileConfig.ts` exporting a plain function `getTileConfig(provider: string)` that returns `{ tiles: string[], attribution: string, tileSize: number, minZoom: number, maxZoom: number }`
- Provider parameter defaults to `'esri'`
- For `'esri'`: tiles = `['cavechef-tiles://esri/{z}/{y}/{x}']`, attribution = `'© Esri, Maxar, Earthstar Geographics'`, tileSize = 256, minZoom = 0, maxZoom = 22
- Throw on unknown provider name (not a silent fallback)
- Write unit tests covering: valid provider, unknown provider throws, default parameter, returned shape
- Refactor `getSatelliteTileConfig` in MapCanvas (`src/components/Map/MapCanvas.tsx:1140-1148`) to import and delegate to the shared utility
- Keep the existing `useCallback` wrapper in MapCanvas — only replace the inline object with a call to the shared utility

## Key context

- MapCanvas currently has `getSatelliteTileConfig` at line 1140 returning `{ tiles: ['cavechef-tiles://esri/{z}/{y}/{x}'], attribution: '© Esri, Maxar, Earthstar Geographics', tileSize: 256 }`
- The utility adds minZoom/maxZoom which MapCanvas doesn't currently use — that's fine, extra fields are harmless
- Follow existing test patterns in `src/utils/` for unit tests (Vitest)
- Provider-aware design prepares for fn-24-pme (provider registry) without over-engineering
## Acceptance
- [ ] `src/utils/tileConfig.ts` exports `getTileConfig(provider?: string)` function
- [ ] Returns `{ tiles, attribution, tileSize, minZoom, maxZoom }` for `'esri'`
- [ ] Throws on unknown provider name
- [ ] Default provider parameter is `'esri'`
- [ ] Unit tests cover valid provider, unknown provider, default parameter
- [ ] MapCanvas `getSatelliteTileConfig` delegates to shared utility
- [ ] MapCanvas `useCallback` wrapper preserved
- [ ] All existing satellite E2E tests pass
- [ ] `pnpm tsc --noEmit` passes
## Done summary
Created shared tile configuration utility (src/utils/tileConfig.ts) exporting getTileConfig(provider?) that returns tiles, attribution, tileSize, minZoom, maxZoom for a given provider (default 'esri'). Refactored MapCanvas getSatelliteTileConfig to delegate to the shared utility while preserving the useCallback wrapper. Added comprehensive unit tests covering valid provider, unknown provider throws, default parameter, returned shape, and immutability.
## Evidence
- Commits: fa61ba5af8b7353c2a47f8f5334fc8e58035c312
- Tests: pnpm test -- --run src/utils/tileConfig.test.ts (5 passed), pnpm tsc --noEmit (only pre-existing MapCanvas canvasContextAttributes error)
- PRs: