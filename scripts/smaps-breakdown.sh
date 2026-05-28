#!/bin/bash
# Categorize a process's VM mappings by purpose using /proc/PID/smaps.
#
# Buckets:
#   code     — file-backed executable
#   rodata   — file-backed read-only data
#   data     — file-backed read-write data
#   stack    — [stack:tid] mappings
#   heap     — [heap] (libc malloc small allocations)
#   shm      — /memfd:/SYSV/dev/shm
#   bmalloc  — anon mappings sized in 2 MB (1 << 21) chunks (JSC bmalloc)
#   jsc-iso  — anon mappings sized in 16 MB (1 << 24) chunks (JSC IsoHeap)
#   big-anon — anon mappings ≥ 64 MB (typed arrays, image buffers, MapLibre)
#   small-anon — anon mappings < 2 MB (everything else: thread stacks, libc arena)
# Within each bucket we report cumulative VirtualSize and Rss.
#
# Usage: smaps-breakdown.sh PID
set -euo pipefail
PID=${1:?usage: $0 PID}
SMAPS=/proc/$PID/smaps
[[ -r $SMAPS ]] || { echo "cannot read $SMAPS"; exit 1; }

awk '
function bucket_for(perms, name, size_kb,    is_anon) {
  is_anon = (name == "" || name == "[anon:]" || name ~ /^\[anon:/)
  if (name == "[stack]" || name ~ /^\[stack:/) return "stack"
  if (name == "[heap]") return "heap"
  if (name ~ /^\/memfd:/ || name ~ /^\/dev\/shm/ || name ~ /^\/SYSV/) return "shm"
  if (name == "[vsyscall]" || name == "[vvar]" || name == "[vdso]") return "vdso"
  if (!is_anon) {
    if (perms ~ /x/) return "code"
    if (perms == "r--p") return "rodata"
    return "data"
  }
  # anonymous
  if (size_kb >= 65536) return "big-anon"
  if (size_kb == 16384) return "jsc-iso-16M"
  if (size_kb == 2048) return "bmalloc-2M"
  if (size_kb > 2048) return "mid-anon"
  return "small-anon"
}

# parse each smaps record
/^[0-9a-f]+-[0-9a-f]+ [-r][-w][-x][ps] / {
  if (in_record) emit_record()
  in_record = 1
  perms = $2
  name = ""
  for (i = 6; i <= NF; i++) name = (name == "" ? $i : name " " $i)
  size_kb = 0; rss_kb = 0; pss_kb = 0
  next
}
/^Size:/ { size_kb = $2; next }
/^Rss:/ { rss_kb = $2; next }
/^Pss:/ { pss_kb = $2; next }

function emit_record() {
  b = bucket_for(perms, name, size_kb)
  size_total[b] += size_kb
  rss_total[b]  += rss_kb
  pss_total[b]  += pss_kb
  count[b]++
  if (b == "big-anon" && rss_kb >= 4096) {
    big_anon_detail[++big_n] = sprintf("%10d KB rss / %10d KB size  %s", rss_kb, size_kb, name == "" ? "[anon]" : name)
  }
}

END {
  if (in_record) emit_record()
  printf "\n=== /proc/%s/smaps breakdown ===\n", pid
  printf "%-14s  %12s  %12s  %12s  %8s\n", "bucket", "size(KB)", "rss(KB)", "pss(KB)", "count"
  total_size = 0; total_rss = 0; total_pss = 0
  # stable order
  buckets = "code rodata data heap stack shm vdso bmalloc-2M jsc-iso-16M mid-anon big-anon small-anon"
  split(buckets, arr, " ")
  for (i = 1; i <= length(arr); i++) {
    b = arr[i]
    if (!(b in count)) continue
    printf "%-14s  %12d  %12d  %12d  %8d\n", b, size_total[b], rss_total[b], pss_total[b], count[b]
    total_size += size_total[b]
    total_rss  += rss_total[b]
    total_pss  += pss_total[b]
  }
  printf "%-14s  %12d  %12d  %12d  %8s\n", "TOTAL", total_size, total_rss, total_pss, ""
  if (big_n) {
    printf "\nbig-anon regions (rss >= 4 MB):\n"
    for (i = 1; i <= big_n; i++) print "  " big_anon_detail[i]
  }
}
' pid=$PID $SMAPS
