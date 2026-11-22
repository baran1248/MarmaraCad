/** WebGPU WGSL conjugate-gradient solver for the 3-DOF-per-node block system
 *  produced by the tetrahedral FEA assembler.
 *
 *  The whole Jacobi-preconditioned PCG iteration runs inside one compute
 *  dispatch (one workgroup, grid-stride over the rows), so no per-iteration
 *  round trip to JavaScript is needed. When WebGPU is unavailable — or the
 *  device rejects the shader — the same interface falls back to a CPU PCG. */

export interface GpuPcgInput {
  /** One entry per node, in block (9-value) units. */
  rowStart: Int32Array;
  /** Scalar column indices; every block starts at a multiple of 3. */
  cols: Int32Array;
  /** Row-major 3×3 blocks, 9 values per block. */
  vals: Float64Array;
  /** Jacobi preconditioner, 3 values per node. */
  diag: Float64Array;
  rhs: Float64Array;
  maxIterations?: number;
  tolerance?: number;
  onIteration?: (iteration: number, residual: number) => void;
}

export interface GpuPcgResult {
  x: Float64Array;
  iterations: number;
  residual: number;
  converged: boolean;
  backend: "webgpu" | "cpu";
}

const SHADER = /* wgsl */ `
struct Params {
  rows: u32,
  maxIter: u32,
  reserved0: u32,
  reserved1: u32,
  tolerance: f32,
  reserved2: f32,
  reserved3: f32,
  reserved4: f32,
};

@group(0) @binding(0) var<storage, read> rowStart: array<u32>;
@group(0) @binding(1) var<storage, read> cols: array<u32>;
@group(0) @binding(2) var<storage, read> vals: array<f32>;
@group(0) @binding(3) var<storage, read> diag: array<f32>;
@group(0) @binding(4) var<storage, read> rhs: array<f32>;
@group(0) @binding(5) var<storage, read_write> x: array<f32>;
@group(0) @binding(6) var<storage, read_write> r: array<f32>;
@group(0) @binding(7) var<storage, read_write> z: array<f32>;
@group(0) @binding(8) var<storage, read_write> p: array<f32>;
@group(0) @binding(9) var<storage, read_write> ap: array<f32>;
@group(0) @binding(10) var<uniform> params: Params;
@group(0) @binding(11) var<storage, read_write> result: array<f32>;

var<workgroup> reduction: array<f32, 256>;
var<workgroup> sharedRz: f32;
var<workgroup> sharedAlpha: f32;
var<workgroup> sharedBeta: f32;
var<workgroup> sharedResidual: f32;
var<workgroup> sharedConverged: u32;
var<workgroup> sharedIteration: u32;

fn blockMatvec(row: u32) -> vec3<f32> {
  var sum = vec3<f32>(0.0, 0.0, 0.0);
  let start = rowStart[row];
  let end = rowStart[row + 1u];
  var k = start;
  loop {
    if (k >= end) { break; }
    let col = cols[k];
    let v = vec3<f32>(x[col], x[col + 1u], x[col + 2u]);
    let b0 = vals[k];
    let b1 = vals[k + 1u];
    let b2 = vals[k + 2u];
    let b3 = vals[k + 3u];
    let b4 = vals[k + 4u];
    let b5 = vals[k + 5u];
    let b6 = vals[k + 6u];
    let b7 = vals[k + 7u];
    let b8 = vals[k + 8u];
    sum.x = sum.x + b0 * v.x + b1 * v.y + b2 * v.z;
    sum.y = sum.y + b3 * v.x + b4 * v.y + b5 * v.z;
    sum.z = sum.z + b6 * v.x + b7 * v.y + b8 * v.z;
    k = k + 9u;
  }
  return sum;
}

fn reduce(value: f32, tid: u32) -> f32 {
  reduction[tid] = value;
  workgroupBarrier();
  var stride = 128u;
  loop {
    if (stride == 0u) { break; }
    if (tid < stride) {
      reduction[tid] = reduction[tid] + reduction[tid + stride];
    }
    workgroupBarrier();
    stride = stride / 2u;
  }
  let total = reduction[0];
  workgroupBarrier();
  return total;
}

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) local: vec3<u32>) {
  let tid = local.x;
  let rows = params.rows;
  if (tid == 0u) {
    sharedRz = 0.0;
    sharedAlpha = 0.0;
    sharedBeta = 0.0;
    sharedResidual = 0.0;
    sharedConverged = 0u;
    sharedIteration = 0u;
  }
  workgroupBarrier();

  // x = 0, r = rhs, z = M⁻¹r, p = z
  var row = tid;
  loop {
    if (row >= rows) { break; }
    let base = row * 3u;
    for (var i = 0u; i < 3u; i = i + 1u) {
      x[base + i] = 0.0;
      r[base + i] = rhs[base + i];
      z[base + i] = r[base + i] / max(1e-20, diag[base + i]);
      p[base + i] = z[base + i];
    }
    row = row + 256u;
  }
  workgroupBarrier();

  var localRz = 0.0;
  row = tid;
  loop {
    if (row >= rows) { break; }
    let base = row * 3u;
    localRz = localRz + r[base] * z[base] + r[base + 1u] * z[base + 1u] + r[base + 2u] * z[base + 2u];
    row = row + 256u;
  }
  let rz = reduce(localRz, tid);
  if (tid == 0u) { sharedRz = rz; }
  workgroupBarrier();

  var iteration = 0u;
  loop {
    if (iteration >= params.maxIter) { break; }
    iteration = iteration + 1u;

    // ap = A p
    row = tid;
    loop {
      if (row >= rows) { break; }
      let base = row * 3u;
      let value = blockMatvec(row);
      ap[base] = value.x;
      ap[base + 1u] = value.y;
      ap[base + 2u] = value.z;
      row = row + 256u;
    }
    workgroupBarrier();

    var localPap = 0.0;
    row = tid;
    loop {
      if (row >= rows) { break; }
      let base = row * 3u;
      localPap = localPap + p[base] * ap[base] + p[base + 1u] * ap[base + 1u] + p[base + 2u] * ap[base + 2u];
      row = row + 256u;
    }
    let pap = reduce(localPap, tid);
    let alpha = select(0.0, sharedRz / pap, pap > 1e-30);
    if (tid == 0u) { sharedAlpha = alpha; }
    workgroupBarrier();

    var localResidual = 0.0;
    row = tid;
    loop {
      if (row >= rows) { break; }
      let base = row * 3u;
      for (var i = 0u; i < 3u; i = i + 1u) {
        x[base + i] = x[base + i] + alpha * p[base + i];
        r[base + i] = r[base + i] - alpha * ap[base + i];
        localResidual = localResidual + r[base + i] * r[base + i];
      }
      row = row + 256u;
    }
    let residual = sqrt(reduce(localResidual, tid));
    if (tid == 0u) {
      sharedResidual = residual;
      sharedIteration = iteration;
      if (residual <= params.tolerance) { sharedConverged = 1u; }
    }
    workgroupBarrier();
    if (sharedConverged == 1u) { break; }

    var localRz2 = 0.0;
    row = tid;
    loop {
      if (row >= rows) { break; }
      let base = row * 3u;
      for (var i = 0u; i < 3u; i = i + 1u) {
        z[base + i] = r[base + i] / max(1e-20, diag[base + i]);
        localRz2 = localRz2 + r[base + i] * z[base + i];
      }
      row = row + 256u;
    }
    let rz2 = reduce(localRz2, tid);
    let beta = select(0.0, rz2 / sharedRz, abs(sharedRz) > 1e-30);
    if (tid == 0u) {
      sharedBeta = beta;
      sharedRz = rz2;
    }
    workgroupBarrier();

    row = tid;
    loop {
      if (row >= rows) { break; }
      let base = row * 3u;
      for (var i = 0u; i < 3u; i = i + 1u) {
        p[base + i] = z[base + i] + beta * p[base + i];
      }
      row = row + 256u;
    }
    workgroupBarrier();
  }

  if (tid == 0u) {
    result[0] = sharedResidual;
    result[1] = f32(sharedIteration);
    result[2] = f32(sharedConverged);
  }
}
`;

function cpuPcg(input: GpuPcgInput): GpuPcgResult {
  const { rowStart, cols, vals, diag, rhs } = input;
  const rows = rowStart.length - 1;
  const n = rows * 3;
  const maxIter = Math.min(input.maxIterations ?? 4000, Math.max(300, n * 2));
  const tolerance = input.tolerance ?? 1e-7;
  const x = new Float64Array(n);
  const r = new Float64Array(rhs);
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const ap = new Float64Array(n);
  let rhsNorm = 0;
  for (let i = 0; i < n; i++) rhsNorm += rhs[i] * rhs[i];
  rhsNorm = Math.sqrt(rhsNorm);
  const tol = tolerance * Math.max(1e-20, rhsNorm);
  if (rhsNorm < 1e-20) return { x, iterations: 0, residual: 0, converged: true, backend: "cpu" };
  for (let i = 0; i < n; i++) z[i] = r[i] / Math.max(1e-20, diag[i]);
  p.set(z);
  let rz = 0;
  for (let i = 0; i < n; i++) rz += r[i] * z[i];
  let residual = rhsNorm;
  let iterations = 0;
  const matvec = (source: Float64Array, out: Float64Array) => {
    for (let row = 0; row < rows; row++) {
      const base = row * 3;
      let a0 = 0, a1 = 0, a2 = 0;
      const start = rowStart[row];
      const end = rowStart[row + 1];
      for (let k = start; k < end; k += 9) {
        const col = cols[k];
        const v0 = source[col], v1 = source[col + 1], v2 = source[col + 2];
        a0 += vals[k] * v0 + vals[k + 1] * v1 + vals[k + 2] * v2;
        a1 += vals[k + 3] * v0 + vals[k + 4] * v1 + vals[k + 5] * v2;
        a2 += vals[k + 6] * v0 + vals[k + 7] * v1 + vals[k + 8] * v2;
      }
      out[base] = a0;
      out[base + 1] = a1;
      out[base + 2] = a2;
    }
  };
  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;
    matvec(p, ap);
    let pap = 0;
    for (let i = 0; i < n; i++) pap += p[i] * ap[i];
    if (pap <= 1e-30) break;
    const alpha = rz / pap;
    let res2 = 0;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * ap[i];
      res2 += r[i] * r[i];
    }
    residual = Math.sqrt(res2);
    if (iter % 50 === 0) input.onIteration?.(iterations, residual);
    if (residual <= tol) return { x, iterations, residual, converged: true, backend: "cpu" };
    let rz2 = 0;
    for (let i = 0; i < n; i++) {
      z[i] = r[i] / Math.max(1e-20, diag[i]);
      rz2 += r[i] * z[i];
    }
    const beta = rz2 / Math.max(1e-30, rz);
    rz = rz2;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  return { x, iterations, residual, converged: residual <= Math.max(tol * 20, rhsNorm * 1e-4), backend: "cpu" };
}

type GpuLike = {
  requestAdapter(): Promise<unknown | null>;
};

export async function gpuPcgSolve(input: GpuPcgInput): Promise<GpuPcgResult> {
  const gpu = (navigator as unknown as { gpu?: GpuLike }).gpu;
  if (!gpu) return cpuPcg(input);
  try {
    const adapter = (await gpu.requestAdapter()) as {
      requestDevice(): Promise<GpuDevice>;
    } | null;
    if (!adapter) return cpuPcg(input);
    const device = await adapter.requestDevice();
    const rows = input.rowStart.length - 1;
    const n = rows * 3;
    const maxIterations = Math.min(400, input.maxIterations ?? 400);
    const bufs: GpuBuffer[] = [];
    const make = (data: ArrayBufferView, usage: number) => {
      const buffer = device.createBuffer({
        size: Math.ceil(data.byteLength / 4) * 4,
        usage: usage | 0x0004, // COPY_DST
        mappedAtCreation: true,
      });
      const target = new Uint8Array(buffer.getMappedRange());
      target.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      buffer.unmap();
      bufs.push(buffer);
      return buffer;
    };
    const storageRead = 0x0080;
    const storageWrite = 0x0088;
    const uniform = 0x0040;
    const rowStart = make(input.rowStart, storageRead);
    const cols = make(input.cols, storageRead);
    const vals = make(Float32Array.from(input.vals), storageRead);
    const diag = make(Float32Array.from(input.diag), storageRead);
    const rhs = make(Float32Array.from(input.rhs), storageRead);
    const x = make(new Float32Array(n), storageWrite | 0x0004);
    const r = make(new Float32Array(input.rhs), storageWrite);
    const z = make(new Float32Array(n), storageWrite);
    const p = make(new Float32Array(n), storageWrite);
    const ap = make(new Float32Array(n), storageWrite);
    const paramsData = new ArrayBuffer(32);
    const u32 = new Uint32Array(paramsData);
    const f32 = new Float32Array(paramsData);
    u32[0] = rows;
    u32[1] = maxIterations;
    f32[4] = (input.tolerance ?? 1e-7) * Math.max(1e-20, Math.sqrt(input.rhs.reduce((sum, v) => sum + v * v, 0)));
    const params = make(new Uint8Array(paramsData), uniform);
    const result = make(new Float32Array(3), storageWrite | 0x0004);

    const module = device.createShaderModule({ code: SHADER });
    const pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: rowStart } },
        { binding: 1, resource: { buffer: cols } },
        { binding: 2, resource: { buffer: vals } },
        { binding: 3, resource: { buffer: diag } },
        { binding: 4, resource: { buffer: rhs } },
        { binding: 5, resource: { buffer: x } },
        { binding: 6, resource: { buffer: r } },
        { binding: 7, resource: { buffer: z } },
        { binding: 8, resource: { buffer: p } },
        { binding: 9, resource: { buffer: ap } },
        { binding: 10, resource: { buffer: params } },
        { binding: 11, resource: { buffer: result } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const output = new Float64Array(n);
    const resultData = new Float32Array(3);
    const gpuX = await readBuffer(device, x, new Float32Array(n));
    for (let i = 0; i < n; i++) output[i] = gpuX[i];
    await readBuffer(device, result, resultData);
    for (const buffer of bufs) buffer.destroy();
    device.destroy?.();
    return {
      x: output,
      iterations: Math.round(resultData[1]),
      residual: resultData[0],
      converged: resultData[2] > 0.5,
      backend: "webgpu",
    };
  } catch {
    return cpuPcg(input);
  }
}

interface GpuBuffer {
  destroy(): void;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
}

interface GpuDevice {
  createBuffer(desc: { size: number; usage: number; mappedAtCreation?: boolean }): GpuBuffer;
  createShaderModule(desc: { code: string }): unknown;
  createComputePipeline(desc: unknown): {
    getBindGroupLayout(index: number): unknown;
  };
  createBindGroup(desc: unknown): unknown;
  createCommandEncoder(): {
    copyBufferToBuffer(source: GpuBuffer, sourceOffset: number, destination: GpuBuffer, destinationOffset: number, size: number): void;
    beginComputePass(): {
      setPipeline(pipeline: unknown): void;
      setBindGroup(index: number, group: unknown): void;
      dispatchWorkgroups(count: number): void;
      end(): void;
    };
    finish(): unknown;
  };
  queue: { submit(buffers: unknown[]): void };
  destroy?(): void;
}

async function readBuffer(device: GpuDevice, buffer: GpuBuffer, target: Float32Array): Promise<Float32Array> {
  // MAP_READ | COPY_DST staging buffer.
  const staging = device.createBuffer({ size: target.byteLength, usage: 0x0001 | 0x0008 }) as GpuBuffer & {
    mapAsync(mode: number): Promise<void>;
    getMappedRange(): ArrayBuffer;
    unmap(): void;
  };
  const encoder = device.createCommandEncoder() as {
    copyBufferToBuffer(source: GpuBuffer, sourceOffset: number, destination: GpuBuffer, destinationOffset: number, size: number): void;
    finish(): unknown;
  };
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, target.byteLength);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(0x0001);
  target.set(new Float32Array(staging.getMappedRange()));
  staging.unmap();
  staging.destroy();
  return target;
}

/** Small helper used by the worker to decide whether a GPU attempt is worth it. */
export async function gpuAvailable(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: GpuLike }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

export { cpuPcg };
