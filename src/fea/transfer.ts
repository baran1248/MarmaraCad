/** Transferable helpers shared by the FEA worker and its unit tests.
 *
 *  A solve reply contains a dozen typed arrays (positions, displacement, von
 *  Mises, magnitude, surface/boundary indices, per-mode shapes…). Structured
 *  cloning copies every one of them in both directions; posting them with an
 *  explicit Transferable list moves the ArrayBuffers instead, so peak memory is
 *  roughly halved for big studies. */

/** Collect every ArrayBuffer reachable from a payload exactly once. */
export function collectTransferables(
  value: unknown,
  list: Transferable[] = [],
  seen = new Set<ArrayBufferLike>(),
  depth = 0,
): Transferable[] {
  if (!value || typeof value !== "object" || depth > 8) return list;
  if (ArrayBuffer.isView(value)) {
    const buffer = value.buffer as ArrayBufferLike;
    if (!seen.has(buffer) && typeof (buffer as ArrayBuffer).byteLength === "number") {
      seen.add(buffer);
      list.push(buffer as ArrayBuffer);
    }
    return list;
  }
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) {
    if (!seen.has(value)) {
      seen.add(value);
      list.push(value);
    }
    return list;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTransferables(item, list, seen, depth + 1);
    return list;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    collectTransferables((value as Record<string, unknown>)[key], list, seen, depth + 1);
  }
  return list;
}

/** True when every buffer in the payload is listed (i.e. nothing is cloned). */
export function isFullyTransferred(payload: unknown, transfer: Transferable[]): boolean {
  const listed = new Set(transfer as ArrayBufferLike[]);
  const found = collectTransferables(payload, [], new Set(), 0) as ArrayBufferLike[];
  return found.length > 0 && found.every((buffer) => listed.has(buffer));
}
