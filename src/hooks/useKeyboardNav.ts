import { useEffect, useCallback, RefObject } from "react";

interface Options {
  items: any[];
  selectedKey: string | null;
  getKey: (item: any) => string;
  onSelect: (item: any) => void;
  onClose?: () => void;
  onDelete?: (item: any) => void;
  searchRef?: RefObject<HTMLInputElement | null>;
  enabled?: boolean;
}

export function useKeyboardNav({
  items,
  selectedKey,
  getKey,
  onSelect,
  onClose,
  onDelete,
  searchRef,
  enabled = true,
}: Options) {
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled) return;
      const tag = (e.target as HTMLElement).tagName;
      const isEditing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      if (isEditing) {
        if (e.key === "Escape") onClose?.();
        return;
      }

      const idx = selectedKey
        ? items.findIndex((i) => getKey(i) === selectedKey)
        : -1;

      switch (e.key) {
        case "j":
        case "ArrowDown": {
          e.preventDefault();
          const next = items[Math.min(idx + 1, items.length - 1)];
          if (next) onSelect(next);
          break;
        }
        case "k":
        case "ArrowUp": {
          e.preventDefault();
          const prev = items[Math.max(idx - 1, 0)];
          if (prev) onSelect(prev);
          break;
        }
        case "Delete":
        case "Backspace": {
          if (selectedKey) {
            const item = items.find((i) => getKey(i) === selectedKey);
            if (item) onDelete?.(item);
          }
          break;
        }
        case "Escape":
          onClose?.();
          break;
        case "/":
          if (searchRef?.current) {
            e.preventDefault();
            searchRef.current.focus();
          }
          break;
      }
    },
    [items, selectedKey, getKey, onSelect, onClose, onDelete, searchRef, enabled]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleKey]);
}
