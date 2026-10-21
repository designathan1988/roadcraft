/** A MESO LINK'S ID: a directed road, its segment and its direction (the far tiles' baked link tables went with the tile streaming) */

/** A link's id: its segment and its direction (0 from the segment's `a` to its `b`). Exact while segment ids stay under 2^52. */
export const linkId = (segment: number, direction: 0 | 1): number => segment * 2 + direction;
export const linkSegment = (link: number): number => Math.floor(link / 2);
export const linkDirection = (link: number): 0 | 1 => (link % 2 === 0 ? 0 : 1);
/** The same road the other way. DO NOT use `^ 1`: ids may pass 2^31. */
export const reverseLink = (link: number): number => (link % 2 === 0 ? link + 1 : link - 1);
