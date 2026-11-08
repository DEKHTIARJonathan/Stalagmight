# Sections, shots and stations

- **Station**: a tie-off.
- **Shot**: the line between two stations. One of three kinds:
  - **Permanent**: along permanent cave line.
  - **Jump** (`J`): temporary line the surveyor lays to connect permanent lines,
    or the main line to the surface.
  - **Reference** (`R`): a shot retaken along a line already surveyed, so two
    sections can be joined exactly, without ambiguity. On
    [import](../workflows/importing-from-mnemo.md), Stalagmight uses them to
    suggest where sections join.
- **LRUD**: left, right, up and down distances to the cave walls, i.e. the
  passage size.
- **Section**: a run of shots, usually one linear stretch of surveyed line.
- **Merging** two stations connects the sections they are on. That is how
  separate sections become one cave.
- **Zero datum**: a station tied to a real-world GPS position. Every other
  station is positioned relative to it. See
  [Setting a zero datum](../workflows/setting-a-zero-datum.md).

Add a section with **Add section** and merge stations with **Merge** in the
[survey view](../screens/survey-view.md). The shot kind is the **J/R** column
in the [Import / Create Section dialog](../screens/create-section-dialog.md).
