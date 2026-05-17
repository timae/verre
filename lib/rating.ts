// Shared rating shape — score (0..5 in 0.25 steps), flavours map, notes.
// Lives in lib/ so server-side code (lib/undoChip.tsx and any future
// non-component caller) can reference it without dragging a UI module
// onto the dependency graph.

export type RatingValue = {
  score: number
  flavors: Record<string, number>
  notes: string
}
