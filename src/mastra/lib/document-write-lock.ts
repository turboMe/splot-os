/**
 * Serializes read-modify-write access to a single anchored-section document.
 *
 * Every domain that builds a deliverable out of anchored sections — chef's Menu
 * Book, content's Content Pack, hunt's report, writer's manuscript — implements
 * the same write: read the whole file, splice one section in, write the whole
 * file back. And every one of those pipelines drafts in PARALLEL batches, so the
 * writers in a batch all read the same bytes and only the last one to land
 * survives.
 *
 * Measured on a live chef run 2026-08-19 (project 8a484c50): eleven recipe
 * sections written, three present in the file — exactly one survivor per
 * parallel batch, plus the card that happened to be written on its own. The
 * database held all fifteen recipes; the delivered document did not. The same
 * run through a different path got lucky and lost nothing, which is what makes
 * this so easy to miss: the loss is nondeterministic, not path-specific.
 *
 * A promise chain per file path is sufficient here — these are single-process
 * tools — and it preserves submission order, so an `append` still lands after
 * the write it was meant to follow. Chain entries are dropped once they drain so
 * a long session does not retain one per project forever.
 */
const writeChains = new Map<string, Promise<unknown>>();

export function withDocumentLock<T>(filePath: string, work: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(filePath) ?? Promise.resolve();
  // Chain off the previous write, and never let ITS rejection cancel this one.
  const result = previous.then(work, work);
  // Track a settled-either-way tail so one failure cannot wedge the chain.
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  writeChains.set(filePath, tail);
  void tail.then(() => {
    if (writeChains.get(filePath) === tail) writeChains.delete(filePath);
  });
  return result;
}

/** Test seam: number of paths currently holding a chain. */
export function pendingDocumentLocks(): number {
  return writeChains.size;
}
