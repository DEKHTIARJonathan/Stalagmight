# WebdriverIO E2E: DMP Integration

## Overview
Implement WebdriverIO E2E tests for DMP file integration. These tests run against the full Tauri application with real backend to validate complete DMP import workflows.

## Scope
- Target: `e2e/specs/dmp-integration.spec.ts` (new file)
- Category: WebdriverIO E2E Tests
- Tests: 6
- Priority: P0 - Critical
- Dependencies: None (uses real backend)

## Approach
1. Create test file in e2e/specs/
2. Create test fixtures in e2e/fixtures/
3. Test DMP v2 and v5 imports
4. Test LRUD preservation
5. Test corrupted file handling
6. Test multi-section files
7. Test metadata extraction
8. Test edge case EOS markers

## Quick commands
- `CARGO_TARGET_DIR=./src-tauri/target xvfb-run -a pnpm test:e2e --spec e2e/specs/dmp-integration.spec.ts`

## Acceptance
- [ ] Test 12.1: `should import DMP v2 file successfully` - Full v2 import workflow
- [ ] Test 12.2: `should import DMP v5 file with LRUD` - LRUD preservation
- [ ] Test 12.3: `should handle corrupted DMP file gracefully` - Error handling
- [ ] Test 12.4: `should import multiple sections from multi-section DMP` - Multi-section
- [ ] Test 12.5: `should preserve section metadata from DMP` - Metadata extraction
- [ ] Test 12.6: `should handle DMP with edge case EOS markers` - EOS edge cases
- [ ] All required fixtures created (test_v2.dmp, test_v5.dmp, etc.)
- [ ] Tests pass with real backend

## References
- Source: `tasks/task-12-dmp-integration.md`
