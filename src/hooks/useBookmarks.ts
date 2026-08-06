/**
 * Bookmarked rows, for the session only.
 *
 * Deliberately not persisted: a bookmark points at a row identifier that is
 * assigned while a folder is being read, so it means nothing once a
 * different folder — or the same folder with a file added — is loaded.
 * Restoring stale bookmarks would silently highlight the wrong events.
 */
import { useCallback, useState } from "react";

export interface Bookmarks {
  readonly ids: ReadonlySet<string>;
  readonly has: (rowId: string) => boolean;
  readonly toggle: (rowId: string) => void;
  readonly clear: () => void;
}

export function useBookmarks(): Bookmarks {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = useCallback((rowId: string) => {
    setIds((current) => {
      const next = new Set(current);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => setIds(new Set()), []);
  const has = useCallback((rowId: string) => ids.has(rowId), [ids]);

  return { ids, has, toggle, clear };
}
