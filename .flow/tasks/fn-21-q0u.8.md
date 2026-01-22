# fn-21-q0u.8 WebdriverIO tests for map centering

## Description
Create WebdriverIO tests for map centering functionality (requires real Tauri app).

**Size:** S
**Files:** `e2e/specs/detail-panel-center.spec.ts` (new)

## Approach

### Test Scenarios
1. **Center on Station**
   - Select a station in detail panel
   - Click center button
   - Verify map has panned (check map center coordinates changed)

2. **Center on Shot**
   - Select a shot in detail panel
   - Click center button
   - Verify map has panned to shot midpoint

3. **Center on Section**
   - Select a section in detail panel
   - Click center button
   - Verify map shows entire section (fitBounds behavior)

### Setup
- Import test DMP file with multiple sections
- Navigate to specific elements for testing

## Key context
- WebdriverIO tests run against real Tauri app
- Use `./scripts/wdio.sh --spec e2e/specs/detail-panel-center.spec.ts` to run
- Can't easily verify exact map position, but can verify map state changed
## Acceptance
- [ ] New test file `e2e/specs/detail-panel-center.spec.ts` created
- [ ] Test verifies center button on station triggers map change
- [ ] Test verifies center button on shot triggers map change
- [ ] Test verifies center button on section triggers map change
- [ ] Tests pass: `./scripts/wdio.sh --spec e2e/specs/detail-panel-center.spec.ts`
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
