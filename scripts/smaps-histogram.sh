#!/bin/bash
# Histogram of anonymous mapping sizes in /proc/PID/smaps.
# Helps fingerprint allocator behaviour:
#   - JSC GC blocks: typically 16 KB
#   - JSC IsoHeap chunks: 16 MB
#   - bmalloc large object chunks: 2 MB
#   - WebGL/Skia/MapLibre big buffers: tens to hundreds of MB
set -euo pipefail
PID=${1:?usage: $0 PID}
SMAPS=/proc/$PID/smaps

awk '
/^[0-9a-f]+-[0-9a-f]+ [-r][-w][-x][ps] / {
  if (in_record) emit_record()
  in_record = 1
  perms = $2
  name = ""
  for (i = 6; i <= NF; i++) name = (name == "" ? $i : name " " $i)
  size_kb = 0; rss_kb = 0
  next
}
/^Size:/ { size_kb = $2; next }
/^Rss:/ { rss_kb = $2; next }

function bucket_label(kb) {
  if (kb < 4) return "<4K"
  if (kb < 16) return "4-15K"
  if (kb < 64) return "16-63K"
  if (kb < 256) return "64-255K"
  if (kb < 1024) return "256K-1M"
  if (kb < 2048) return "1-2M"
  if (kb < 4096) return "2-4M"
  if (kb < 8192) return "4-8M"
  if (kb < 16384) return "8-16M"
  if (kb < 32768) return "16-32M"
  if (kb < 65536) return "32-64M"
  if (kb < 262144) return "64-256M"
  if (kb < 1048576) return "256M-1G"
  return ">=1G"
}

function emit_record() {
  is_anon = (name == "" || name == "[anon:]" || name ~ /^\[anon:/)
  if (!is_anon) return
  b = bucket_label(size_kb)
  cnt[b]++
  vsz[b] += size_kb
  rss[b] += rss_kb
}

END {
  if (in_record) emit_record()
  printf "\n=== anonymous mapping size histogram for PID %s ===\n", pid
  printf "%-10s  %8s  %14s  %14s  %14s\n", "bucket", "count", "vm_size(KB)", "rss(KB)", "rss_avg(KB)"
  order = "<4K 4-15K 16-63K 64-255K 256K-1M 1-2M 2-4M 4-8M 8-16M 16-32M 32-64M 64-256M 256M-1G >=1G"
  n = split(order, arr, " ")
  for (i = 1; i <= n; i++) {
    b = arr[i]
    if (!(b in cnt)) continue
    avg = (cnt[b] > 0) ? int(rss[b]/cnt[b]) : 0
    printf "%-10s  %8d  %14d  %14d  %14d\n", b, cnt[b], vsz[b], rss[b], avg
  }
}
' pid=$PID $SMAPS
