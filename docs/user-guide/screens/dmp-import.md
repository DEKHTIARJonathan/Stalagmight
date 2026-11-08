# DMP import

Imports an mNemo `.dmp` file into the open project, in steps. Opened by
**Import** in the [survey view](survey-view.md).

## Step 1: pick sections

![DMP import, step 1](../images/dmp-import-step1.png)

1. **Close**: nothing imported.
2. **Surveyor**: for every imported section.
3. **Date Override**: one date for every section, instead of the dates in the
   file.
4. **Select All**, **Select None**, **Invert**
5. An empty section. It has no shots and can't be picked.
6. Tick the sections to import.
7. **Cancel**: same as 1.
8. **Continue to Section Setup**

### Details

- Sections already imported into this project are marked **(already imported)**
  and left unticked. A whole file imported before gets a warning at the top.
- The box at the top shows the file, its number of shots, total length and
  depth range.
- **Direction**: whether the line was surveyed going in or out.

## Step 2: zero datum (optional)

Only shown when the project has no
[zero datum](../concepts/sections-shots-stations.md) yet.

![DMP import, zero datum section](../images/dmp-import-zero-datum.png)

1. **Close**: nothing imported.
2. Help on zero datums.
3. Click the section that should carry the zero datum. Next you pick its
   station and GPS position.
4. **Cancel**: same as 1.
5. **Back**: to step 1.
6. **Skip Zero Datum**: import without one. It can be
   [set later](../workflows/setting-a-zero-datum.md).
