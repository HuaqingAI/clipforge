/** Historical scripts stay available by id; only an explicit selection is current. */
export function resolveCurrentScript<T extends { selected?: boolean | null }>(rows: readonly T[]): T | undefined {
  return rows.find((row) => row.selected);
}
