// Owned by track ② Level. Edge-grid navigation: build once per layout, query with a door-state callback.
export { EDGE, SOLID_ITEMS, buildEdgeGrid, initialDoorOpen, doorStateArray, ALL_OPEN, ALL_CLOSED, spaceAt, cellOf, edgeIndex, edgeCode, edgeDoor, canWalk, spaceLinks } from './grid.ts';
export type { EdgeCode, DoorOpenFn, EdgeGrid, EdgeGridSource, SpaceLink } from './grid.ts';
export { floodCells, pathDistanceField, soundFlood, fieldAt, astar, pathDistance, pathPoints } from './path.ts';
export type { NavMode, FloodOptions, AStarOptions, AStarResult } from './path.ts';
export { los, walkClear, smoothPath } from './los.ts';
export { Audibility, UNREACHABLE } from './audibility.ts';
export type { AudPoint, AudibilityOptions } from './audibility.ts';
export { MinHeap } from './heap.ts';
