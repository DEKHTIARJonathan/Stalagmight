# Rust Tests: DMP Parser Edge Cases

## Overview
| Field | Value |
|-------|-------|
| **Epic ID** | fn-37-rxr |
| **Category** | Rust Unit Tests |
| **Target File** | `src-tauri/src/parsers/dmp.rs` |
| **Tests** | 5 |
| **Priority** | P2 - Medium |
| **Source** | `tasks/task-04-dmp-parser-edge-cases.md` |

## Objective
Implement edge case tests for the mNemo DMP file parser. These tests validate handling of different DMP versions (2-5), corrupted files, truncated data, and invalid values.

## Test Specifications

### Test 4.1: `test_parse_dmp_v3_format`
Verify DMP version 3 files (21-byte shots) are correctly parsed without LRUD data.

### Test 4.2: `test_parse_dmp_v4_with_lrud`
Verify DMP version 4 files (29-byte shots) correctly extract LRUD data and direction field.

### Test 4.3: `test_parse_dmp_corrupted_header`
Verify graceful error handling for files with invalid magic bytes or corrupted headers.

### Test 4.4: `test_parse_dmp_truncated_file`
Verify graceful handling when file ends unexpectedly mid-section or mid-shot.

### Test 4.5: `test_parse_dmp_invalid_date_values`
Verify no panic and graceful handling when date fields contain invalid values (month 13, day 32, Feb 30, year 0).

## Edge Cases Summary
| Test | Edge Cases Covered |
|------|-------------------|
| 4.1 | V3 format, missing LRUD, legacy format support |
| 4.2 | V4 format, LRUD extraction, direction field |
| 4.3 | Wrong magic, truncated magic, bad version, version 0 |
| 4.4 | Mid-shot truncation, mid-header truncation, missing EOS |
| 4.5 | Month 13, day 32, Feb 30, year 0, extreme values |

## Verification
```bash
cd src-tauri && cargo test parsers::dmp::tests -- --nocapture
```

## Definition of Done
- [ ] All 5 tests implemented
- [ ] Edge case tests cover malformed data
- [ ] No panics on any invalid input
- [ ] Error messages are helpful
- [ ] Tests pass locally
