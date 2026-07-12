/ #275: a fixed station with a non-finite UTM location must be skipped as an
/ anchor candidate (with a warning) instead of poisoning the UTM->WGS84
/ projection; the finite station stays eligible.
&North American 1983;
$13;
@546866.900,3561472.900,1414.100,13,-0.260;
!ot;
#simple.dat, A1[m,nan,3561472.900,1414.100], A2[m,546900.000,3561500.000,1420.000];
