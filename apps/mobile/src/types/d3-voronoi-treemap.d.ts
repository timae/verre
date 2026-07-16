// Minimal typing for d3-voronoi-treemap (no @types package exists). The
// computed `polygon` arrays land on the hierarchy nodes; callers cast for it.
declare module 'd3-voronoi-treemap' {
  export interface VoronoiTreemap {
    (root: unknown): void
    clip(polygon: Array<[number, number]>): this
    convergenceRatio(value: number): this
    maxIterationCount(value: number): this
    minWeightRatio(value: number): this
    prng(fn: () => number): this
  }
  export function voronoiTreemap(): VoronoiTreemap
}
