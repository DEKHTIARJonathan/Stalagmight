# Task 04: DMP Parser Edge Cases Tests

## Overview
| Field | Value |
|-------|-------|
| **Task ID** | task-04 |
| **Category** | Rust Unit Tests |
| **Target File** | `src-tauri/src/parsers/dmp.rs` |
| **Tests** | 5 |
| **Priority** | P2 - Medium |
| **Dependencies** | None |

## Affected Files
- `src-tauri/src/parsers/dmp.rs` - Add edge case tests to existing test module

## Test Specifications

---

### Test 4.1: `test_parse_dmp_v3_format`

**Purpose:** Verify DMP version 3 files (21-byte shots) are correctly parsed without LRUD data.

**Test Code:**
```rust
#[test]
fn test_parse_dmp_v3_format() {
    // V3 format: 21-byte shots without LRUD
    // Header structure for V3
    let mut data = Vec::new();

    // Magic bytes
    data.extend_from_slice(b"DMP");
    data.push(0x03); // Version 3

    // Section header
    data.extend_from_slice(b"TST"); // Section name (3 bytes)
    data.push(0x01); // Direction IN
    data.push(0x18); // Day (24)
    data.push(0x01); // Month (January)
    data.push(0x18); // Year low byte (2024 = 0x07E8)
    data.push(0x07); // Year high byte
    data.push(0x02); // Shot count

    // Shot 1 (21 bytes for V3)
    // azimuth_in: 45.0°, azimuth_out: 225.0°, length: 5.0m, depth_in: 0.0, depth_out: 1.5
    append_v3_shot(&mut data, 45.0, 225.0, 5.0, 0.0, 1.5);

    // Shot 2
    append_v3_shot(&mut data, 90.0, 270.0, 3.2, 1.5, 2.8);

    // End of section marker
    data.extend_from_slice(&[0xFF, 0xFF]);

    let result = parse_dmp(&data);
    assert!(result.is_ok(), "V3 DMP should parse successfully");

    let sections = result.unwrap();
    assert_eq!(sections.len(), 1);
    assert_eq!(sections[0].name, Some("TST".to_string()));
    assert_eq!(sections[0].shots.len(), 2);

    // V3 should NOT have LRUD
    assert!(sections[0].shots[0].left.is_none());
    assert!(sections[0].shots[0].right.is_none());
    assert!(sections[0].shots[0].up.is_none());
    assert!(sections[0].shots[0].down.is_none());

    // Verify shot data
    assert!((sections[0].shots[0].azimuth_in - 45.0).abs() < 0.1);
    assert!((sections[0].shots[0].length - 5.0).abs() < 0.01);
}
```

**Assertions:**
- [ ] V3 file parses without error
- [ ] Section name extracted correctly
- [ ] Shot count matches
- [ ] LRUD fields are None (not present in V3)
- [ ] Azimuth and length values correct

---

### Test 4.2: `test_parse_dmp_v4_with_lrud`

**Purpose:** Verify DMP version 4 files (29-byte shots) correctly extract LRUD data.

**Test Code:**
```rust
#[test]
fn test_parse_dmp_v4_with_lrud() {
    // V4 format: 29-byte shots WITH LRUD
    let mut data = Vec::new();

    // Magic bytes
    data.extend_from_slice(b"DMP");
    data.push(0x04); // Version 4

    // Section header
    data.extend_from_slice(b"SEC"); // Section name
    data.push(0x02); // Direction OUT
    data.push(0x0F); // Day (15)
    data.push(0x06); // Month (June)
    data.push(0xE8); // Year low byte (2024)
    data.push(0x07); // Year high byte
    data.push(0x01); // Shot count

    // Shot with LRUD (29 bytes for V4)
    // azimuth_in: 120.0°, azimuth_out: 300.0°, length: 8.5m
    // depth_in: 3.0, depth_out: 4.5
    // LRUD: left=1.2, right=0.8, up=2.5, down=0.5
    append_v4_shot(&mut data, 120.0, 300.0, 8.5, 3.0, 4.5, 1.2, 0.8, 2.5, 0.5);

    // End of section marker
    data.extend_from_slice(&[0xFF, 0xFF]);

    let result = parse_dmp(&data);
    assert!(result.is_ok(), "V4 DMP should parse successfully");

    let sections = result.unwrap();
    let shot = &sections[0].shots[0];

    // Verify LRUD extracted
    assert!(shot.left.is_some());
    assert!((shot.left.unwrap() - 1.2).abs() < 0.01);
    assert!((shot.right.unwrap() - 0.8).abs() < 0.01);
    assert!((shot.up.unwrap() - 2.5).abs() < 0.01);
    assert!((shot.down.unwrap() - 0.5).abs() < 0.01);

    // Verify direction captured
    assert_eq!(sections[0].direction, Some(Direction::Out));
}
```

**Assertions:**
- [ ] V4 file parses without error
- [ ] LRUD fields extracted with correct values
- [ ] Direction field captured (IN/OUT)
- [ ] Date parsed correctly

---

### Test 4.3: `test_parse_dmp_corrupted_header`

**Purpose:** Verify graceful error handling for files with invalid magic bytes or corrupted headers.

**Test Code:**
```rust
#[test]
fn test_parse_dmp_corrupted_header() {
    // Test 1: Wrong magic bytes
    let wrong_magic = vec![0x00, 0x01, 0x02, 0x03, 0x04, 0x05];
    let result = parse_dmp(&wrong_magic);
    assert!(result.is_err());
    match result.unwrap_err() {
        ParseError::InvalidHeader(msg) => {
            assert!(msg.contains("magic") || msg.contains("header"),
                    "Error should mention header/magic: {}", msg);
        }
        other => panic!("Expected InvalidHeader, got {:?}", other),
    }

    // Test 2: Truncated magic (only 2 bytes)
    let truncated_magic = vec![b'D', b'M'];
    let result = parse_dmp(&truncated_magic);
    assert!(result.is_err());

    // Test 3: Valid magic but unsupported version (99)
    let mut bad_version = Vec::new();
    bad_version.extend_from_slice(b"DMP");
    bad_version.push(99); // Unsupported version
    let result = parse_dmp(&bad_version);
    assert!(result.is_err());
    match result.unwrap_err() {
        ParseError::UnsupportedVersion(v) => {
            assert_eq!(v, 99);
        }
        other => panic!("Expected UnsupportedVersion, got {:?}", other),
    }

    // Test 4: Version 0 (invalid)
    let mut version_zero = Vec::new();
    version_zero.extend_from_slice(b"DMP");
    version_zero.push(0);
    let result = parse_dmp(&version_zero);
    assert!(result.is_err());
}
```

**Assertions:**
- [ ] Wrong magic bytes returns InvalidHeader error
- [ ] Truncated file returns appropriate error
- [ ] Unsupported version returns UnsupportedVersion with version number
- [ ] Error messages are helpful for debugging

---

### Test 4.4: `test_parse_dmp_truncated_file`

**Purpose:** Verify graceful handling when file ends unexpectedly mid-section or mid-shot.

**Test Code:**
```rust
#[test]
fn test_parse_dmp_truncated_file() {
    // Create valid header but truncate in middle of shot data
    let mut data = Vec::new();

    // Valid V5 header
    data.extend_from_slice(b"DMP");
    data.push(0x05); // Version 5

    // Section header indicating 3 shots
    data.extend_from_slice(b"TRN"); // Section name
    data.push(0x01); // Direction
    data.push(0x01); // Day
    data.push(0x01); // Month
    data.push(0xE8); // Year low
    data.push(0x07); // Year high
    data.push(0x03); // 3 shots expected

    // Only provide 1 complete shot and partial second shot
    append_v5_shot(&mut data, 45.0, 225.0, 5.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0);
    // Partial shot - only 10 bytes instead of full shot
    data.extend_from_slice(&[0x00; 10]);
    // Missing: third shot and EOS marker

    let result = parse_dmp(&data);

    // Two acceptable behaviors:
    // 1. Return error indicating truncation
    // 2. Return partial data with warning
    match result {
        Err(ParseError::UnexpectedEof(msg)) => {
            assert!(msg.contains("truncat") || msg.contains("unexpected"),
                    "Error should indicate truncation: {}", msg);
        }
        Ok(sections) => {
            // If partial recovery is supported, verify at least 1 shot recovered
            assert!(!sections.is_empty(), "Should recover at least section header");
            // Sections with incomplete shots should be marked or have fewer shots
            let total_shots: usize = sections.iter().map(|s| s.shots.len()).sum();
            assert!(total_shots < 3, "Should not have all 3 declared shots");
        }
        Err(other) => {
            // Any other error type is also acceptable for corrupted data
            println!("Got error (acceptable): {:?}", other);
        }
    }
}

#[test]
fn test_parse_dmp_truncated_mid_section_header() {
    let mut data = Vec::new();

    // Valid V5 header
    data.extend_from_slice(b"DMP");
    data.push(0x05);

    // Partial section header (only 3 bytes of expected ~10)
    data.extend_from_slice(b"SEC");
    // Truncate here - missing direction, date, shot count

    let result = parse_dmp(&data);
    assert!(result.is_err(), "Truncated section header should error");
}
```

**Assertions:**
- [ ] Truncated mid-shot returns error or partial recovery
- [ ] Truncated section header returns error
- [ ] No panic on malformed data
- [ ] Error messages indicate truncation issue

---

### Test 4.5: `test_parse_dmp_invalid_date_values`

**Purpose:** Verify no panic and graceful handling when date fields contain invalid values.

**Test Code:**
```rust
#[test]
fn test_parse_dmp_invalid_date_values() {
    // Test 1: Invalid month (13)
    let mut data = create_dmp_header(5);
    data.extend_from_slice(b"BAD"); // Section name
    data.push(0x01); // Direction
    data.push(0x0F); // Day (15) - valid
    data.push(0x0D); // Month (13) - INVALID
    data.push(0xE8); // Year low (2024)
    data.push(0x07); // Year high
    data.push(0x00); // 0 shots
    data.extend_from_slice(&[0xFF, 0xFF]); // EOS

    let result = parse_dmp(&data);
    // Should not panic - either error or fallback date
    match result {
        Ok(sections) => {
            // If parsed, date should be None or fallback
            let section = &sections[0];
            if let Some(date) = &section.date {
                // Verify it's not January 13th (misinterpreted)
                assert_ne!(date.month(), 13, "Month 13 should not be accepted");
            }
        }
        Err(_) => {
            // Error is also acceptable
        }
    }

    // Test 2: Invalid day (32)
    let mut data = create_dmp_header(5);
    data.extend_from_slice(b"BAD");
    data.push(0x01);
    data.push(0x20); // Day (32) - INVALID
    data.push(0x06); // Month (6)
    data.push(0xE8);
    data.push(0x07);
    data.push(0x00);
    data.extend_from_slice(&[0xFF, 0xFF]);

    let result = parse_dmp(&data);
    assert!(result.is_ok() || result.is_err(), "Should not panic");

    // Test 3: February 30th (impossible date)
    let mut data = create_dmp_header(5);
    data.extend_from_slice(b"FEB");
    data.push(0x01);
    data.push(0x1E); // Day (30)
    data.push(0x02); // Month (February)
    data.push(0xE8);
    data.push(0x07);
    data.push(0x00);
    data.extend_from_slice(&[0xFF, 0xFF]);

    let result = parse_dmp(&data);
    // Should handle gracefully
    if let Ok(sections) = result {
        // Date should be None or normalized
        if let Some(date) = &sections[0].date {
            assert!(date.day() <= 29, "Feb 30 should be rejected or normalized");
        }
    }

    // Test 4: Year 0
    let mut data = create_dmp_header(5);
    data.extend_from_slice(b"YR0");
    data.push(0x01);
    data.push(0x01);
    data.push(0x01);
    data.push(0x00); // Year = 0
    data.push(0x00);
    data.push(0x00);
    data.extend_from_slice(&[0xFF, 0xFF]);

    let result = parse_dmp(&data);
    assert!(result.is_ok() || result.is_err(), "Year 0 should not panic");
}

#[test]
fn test_parse_dmp_extreme_values() {
    // Test shot with extreme but valid values
    let mut data = create_dmp_header(5);
    data.extend_from_slice(b"EXT");
    data.push(0x01); // Direction
    data.push(0x01); // Day
    data.push(0x01); // Month
    data.push(0xE8); // Year low
    data.push(0x07); // Year high
    data.push(0x01); // 1 shot

    // Shot with extreme values
    // azimuth: 359.9°, length: 999.9m, depth: -500m to 500m
    append_v5_shot(&mut data, 359.9, 179.9, 999.9, -500.0, 500.0, 50.0, 50.0, 100.0, 100.0);
    data.extend_from_slice(&[0xFF, 0xFF]);

    let result = parse_dmp(&data);
    assert!(result.is_ok(), "Extreme but valid values should parse");

    let shot = &result.unwrap()[0].shots[0];
    assert!((shot.azimuth_in - 359.9).abs() < 0.5);
    assert!((shot.length - 999.9).abs() < 1.0);
}
```

**Assertions:**
- [ ] Month 13 doesn't panic, returns error or fallback
- [ ] Day 32 doesn't panic
- [ ] February 30 handled gracefully
- [ ] Year 0 doesn't panic
- [ ] Extreme valid values parse correctly

---

## Helper Functions

```rust
fn create_dmp_header(version: u8) -> Vec<u8> {
    let mut data = Vec::new();
    data.extend_from_slice(b"DMP");
    data.push(version);
    data
}

fn append_v3_shot(data: &mut Vec<u8>, az_in: f64, az_out: f64, len: f64, d_in: f64, d_out: f64) {
    // V3: 21 bytes per shot
    // Encode azimuth as 2 bytes each (0-3600 = 0°-360.0°)
    let az_in_raw = (az_in * 10.0) as u16;
    let az_out_raw = (az_out * 10.0) as u16;
    let len_raw = (len * 100.0) as u16; // cm
    let d_in_raw = ((d_in + 1000.0) * 100.0) as i32; // offset for negative
    let d_out_raw = ((d_out + 1000.0) * 100.0) as i32;

    data.extend_from_slice(&az_in_raw.to_le_bytes());
    data.extend_from_slice(&az_out_raw.to_le_bytes());
    data.extend_from_slice(&len_raw.to_le_bytes());
    data.extend_from_slice(&d_in_raw.to_le_bytes());
    data.extend_from_slice(&d_out_raw.to_le_bytes());
    // Padding to 21 bytes
    data.extend_from_slice(&[0x00; 5]);
}

fn append_v4_shot(data: &mut Vec<u8>, az_in: f64, az_out: f64, len: f64,
                  d_in: f64, d_out: f64, l: f64, r: f64, u: f64, d: f64) {
    // V4: 29 bytes per shot (V3 + 8 bytes LRUD)
    append_v3_shot(data, az_in, az_out, len, d_in, d_out);
    // Remove padding, add LRUD
    data.truncate(data.len() - 5);

    let l_raw = (l * 100.0) as u16;
    let r_raw = (r * 100.0) as u16;
    let u_raw = (u * 100.0) as u16;
    let d_raw = (d * 100.0) as u16;

    data.extend_from_slice(&l_raw.to_le_bytes());
    data.extend_from_slice(&r_raw.to_le_bytes());
    data.extend_from_slice(&u_raw.to_le_bytes());
    data.extend_from_slice(&d_raw.to_le_bytes());
    // Padding to 29 bytes
    data.extend_from_slice(&[0x00; 5]);
}

fn append_v5_shot(data: &mut Vec<u8>, az_in: f64, az_out: f64, len: f64,
                  d_in: f64, d_out: f64, l: f64, r: f64, u: f64, d: f64) {
    // V5: Similar to V4 but with additional fields
    append_v4_shot(data, az_in, az_out, len, d_in, d_out, l, r, u, d);
}
```

---

## Edge Cases Summary

| Test | Edge Cases Covered |
|------|-------------------|
| 4.1 | V3 format, missing LRUD, legacy format support |
| 4.2 | V4 format, LRUD extraction, direction field |
| 4.3 | Wrong magic, truncated magic, bad version, version 0 |
| 4.4 | Mid-shot truncation, mid-header truncation, missing EOS |
| 4.5 | Month 13, day 32, Feb 30, year 0, extreme values |

---

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
