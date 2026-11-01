export interface SelectionModifiers {
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export function selectListItem(
  orderedIds: readonly string[],
  current: ReadonlySet<string>,
  anchor: string | null,
  target: string,
  modifiers: SelectionModifiers = {},
  toggle = false,
): { selected: Set<string>; anchor: string } {
  const targetIndex = orderedIds.indexOf(target), anchorIndex = anchor === null ? -1 : orderedIds.indexOf(anchor);
  if (targetIndex < 0) return { selected: new Set(current), anchor: anchor ?? target };
  if (modifiers.shiftKey && anchorIndex >= 0) {
    const range = orderedIds.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1);
    const selected = new Set(modifiers.ctrlKey || modifiers.metaKey ? current : []);
    range.forEach(id => selected.add(id));
    return { selected, anchor: anchor! };
  }
  const selected = new Set(toggle || modifiers.ctrlKey || modifiers.metaKey ? current : []);
  if (selected.has(target)) selected.delete(target);
  else selected.add(target);
  return { selected, anchor: target };
}
