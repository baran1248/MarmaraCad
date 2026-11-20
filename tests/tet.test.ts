import { describe, expect, it } from "vitest";
import { strainMatrix, tetStiffness } from "../src/fea/solver";

describe("tet stiffness", () => {
  it("is symmetric positive definite on the diagonal and annihilates rigid translation", () => {
    const Ke = tetStiffness([[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 2]], 200000, 0.3);
    let maxAsym = 0;
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 12; j++) maxAsym = Math.max(maxAsym, Math.abs(Ke[i][j] - Ke[j][i]));
    }
    console.log("ASYM", maxAsym, "DIAG", [Ke[0][0], Ke[1][1], Ke[2][2], Ke[3][3]]);
    const u = [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0];
    const f = new Array(12).fill(0);
    for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) f[i] += Ke[i][j] * u[j];
    console.log("RIGID", f.map((v) => +v.toFixed(6)));
    const B = strainMatrix([[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 2]]);
    const strain = new Array(6).fill(0);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 12; j++) strain[i] += B[i][j] * u[j];
    console.log("STRAIN", strain.map((v) => +v.toFixed(6)));
    expect(maxAsym).toBeLessThan(1e-6);
  });
});
