/ Synthetic multi-#file project to exercise per-file DATUM/UTM/declination
/ overrides surfaced by `parse_mak`.  File 0 uses NAD-1983 / UTM 13 with
/ declination policy Entered; file 1 references the same DAT but declares
/ WGS 1984 / UTM 14 with declination policy Auto.  parse_mak should
/ emit a warning per divergence; per-survey state must reflect the file
/ that introduced the survey, not file 0.
&North American 1983;
$13;
@500000.000,4000000.000,1000.000,13,0.000;
!E;
#simple.dat;

&WGS 1984;
$14;
@500000.000,4000000.000,1000.000,14,0.000;
!A;
#simple.dat;
