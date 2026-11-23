import { describe, expect, it } from "vitest";
import { collectTransferables, isFullyTransferred } from "../src/fea/transfer";

/** Zero-copy FEA worker transport: every big buffer must be listed as a
 *  Transferable, otherwise structured clone copies the mesh in both directions. */

const payload = () => ({
  nodes: 3,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
  nested: {
    displacement: new Float64Array([0, 0.1, 0.2]),
    frames: [{ mode: new Float32Array([1, 2, 3]) }, { mode: new Float32Array([4, 5, 6]) }],
    label: "bending",
  },
});

describe("FEA transferables", () => {
  it("collects every typed array buffer exactly once", () => {
    const p = payload();
    const list = collectTransferables(p);
    expect(list).toHaveLength(5);
    expect(new Set(list).size).toBe(list.length);
    // The very same ArrayBuffer instances are listed, not copies.
    expect(list).toContain(p.positions.buffer);
    expect(list).toContain(p.nested.displacement.buffer);
    expect(list).toContain(p.nested.frames[1].mode.buffer);
  });

  it("reports a payload as fully transferred when nothing is left to copy", () => {
    const p = payload();
    const list = collectTransferables(p);
    expect(isFullyTransferred(p, list)).toBe(true);
    expect(isFullyTransferred(p, list.slice(0, -1))).toBe(false);
    expect(isFullyTransferred(p, [])).toBe(false);
  });

  it("does not list the same buffer twice (views share a buffer)", () => {
    const buffer = new ArrayBuffer(64);
    const view = new Float32Array(buffer, 0, 4);
    const tail = new Float32Array(buffer, 32, 4);
    const list = collectTransferables({ view, tail });
    expect(list).toHaveLength(1);
    expect(list[0]).toBe(buffer);
    void view;
    void tail;
  });

  it("ignores scalars, strings and null payloads", () => {
    expect(collectTransferables({ a: 1, b: "text", c: null, d: undefined })).toHaveLength(0);
    expect(collectTransferables(null)).toHaveLength(0);
    expect(isFullyTransferred({ a: 1 }, [])).toBe(false);
  });

  it("stops at the depth guard so cyclic documents cannot hang the worker", () => {
    const cyclic: Record<string, unknown> = { data: new Float32Array([1, 2]) };
    let cursor = cyclic;
    for (let i = 0; i < 20; i++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    cursor.data = new Float32Array([3, 4]);
    const list = collectTransferables(cyclic);
    expect(list).toHaveLength(1);
  });
});
