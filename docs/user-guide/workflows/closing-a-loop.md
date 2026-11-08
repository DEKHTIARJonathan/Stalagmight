# Closing a loop

Use the **Merge** tool on two stations that cannot be merged: their sections
are already connected another way, or both are fixed by a
[zero datum](../concepts/sections-shots-stations.md). Stalagmight then creates a
[loop closure](../concepts/sections-shots-stations.md) instead.

1. In the [survey view](../screens/survey-view.md), pick **Merge** (`M`).
2. Click the first station, then the second.
3. Check the stations and the error in the
   [Create Loop Closure dialog](../screens/closure-dialog.md) and click **Create
   Closure**.

The closure shows as a dashed line. The survey itself does not move. To see it
adjusted to its closures, switch to **Plan**, or pick **Closures Computed View**
under **Display**.

## Step details

### 1-2. Pick both stations

![Picking the stations for a closure](../images/closure-step1.png)

- **Merge** (1) is active, as for [merging stations](merging-stations.md).
- The first station (3) is picked. Click the second (4).

### 3. Create the closure

![Create Loop Closure dialog](../images/closure-dialog.png)

- The two stations (3, 4) and the error (5): here the survey misses by 9.3 m
  (7) over 423.3 m (6), 2.2%.
- **Create Closure** (9).
