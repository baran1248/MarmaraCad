/* OpenCascade.js object lifetime management (RAII).
 *
 * OpenCascade.js is Emscripten/embind: every `new oc.gp_Pnt_3(...)` allocates a
 * C++ object that the JavaScript garbage collector does NOT free. A rebuild that
 * creates hundreds of temporary points, vectors, transforms and boolean
 * algorithms therefore leaks C++ heap until the worker is torn down. The
 * workbench rebuilds on every dimension edit, so this is the single biggest
 * memory leak in the app.
 *
 * `OcctScope` is a small RAII container: objects are tracked when they are
 * created and `.delete()`d when the scope closes. Objects that must survive the
 * scope (the B-Rep that becomes the cached body) are released with `keep()`.
 *
 * `OcctMemory.wrap()` returns a Proxy over the Emscripten module that tracks the
 * result of every constructor automatically, so `new oc.*` sites do not need to
 * be edited one by one. Static helpers that return fresh value objects (for
 * example `TopoDS.Edge_1`) are tracked explicitly with `scope.track(...)` where
 * they matter. */

export interface Deletable {
  delete?: () => void;
  IsNull?: () => boolean;
}

export interface OcctScopeReport {
  /** Objects handed to the scope. */
  created: number;
  /** Objects successfully `.delete()`d by `dispose()`. */
  deleted: number;
  /** Objects released with `keep()` (they outlive the scope on purpose). */
  kept: number;
  /** Objects that were alive when the scope closed (created - deleted - kept). */
  leaked: number;
  /** `delete()` calls that threw; the scope keeps going. */
  failed: number;
}

export interface OcctMemorySnapshot {
  /** Scopes opened so far. */
  scopes: number;
  /** Scopes that are still open (should be 0 between operations). */
  openScopes: number;
  created: number;
  deleted: number;
  kept: number;
  failed: number;
  /** Tracked objects that were never freed and are not intentionally kept. */
  leaked: number;
  /** Objects created while no scope was open (they cannot be reclaimed). */
  untracked: number;
}

function isDeletable(value: unknown): value is Deletable {
  return Boolean(value) && typeof (value as Deletable).delete === "function";
}

export class OcctScope {
  readonly label: string;
  private objects: unknown[] = [];
  private kept = new Set<unknown>();
  private disposed = false;
  private report: OcctScopeReport = { created: 0, deleted: 0, kept: 0, leaked: 0, failed: 0 };

  constructor(label = "occt") {
    this.label = label;
  }

  /** Register a C++ object so it is released when the scope closes. */
  track<T>(object: T): T {
    if (!isDeletable(object) || this.disposed) return object;
    if (this.kept.has(object)) return object;
    this.objects.push(object);
    this.report.created++;
    return object;
  }

  /** Promise an object out of the scope: it stays alive after `dispose()`. */
  keep<T>(object: T): T {
    if (!isDeletable(object)) return object;
    this.kept.add(object);
    this.report.kept++;
    return object;
  }

  /** Tracked objects that are still alive. */
  get live(): number {
    return this.objects.length;
  }

  get stats(): OcctScopeReport {
    return { ...this.report };
  }

  /** Delete every tracked object (newest first) and report the result. */
  dispose(): OcctScopeReport {
    if (this.disposed) return this.stats;
    this.disposed = true;
    for (let i = this.objects.length - 1; i >= 0; i--) {
      const object = this.objects[i] as Deletable;
      if (this.kept.has(object)) continue;
      try {
        object.delete?.();
        this.report.deleted++;
      } catch {
        this.report.failed++;
      }
    }
    this.report.leaked = Math.max(0, this.report.created - this.report.deleted - this.report.kept);
    this.objects = [];
    return this.stats;
  }
}

/** Process-wide coordinator: the active scope + the lifetime counters. */
export class OcctMemory {
  private stack: OcctScope[] = [];
  private totals = { created: 0, deleted: 0, kept: 0, failed: 0, scopes: 0, untracked: 0 };

  get current(): OcctScope | null {
    return this.stack.length ? this.stack[this.stack.length - 1] : null;
  }

  get depth(): number {
    return this.stack.length;
  }

  /** Track into the innermost open scope. Outside a scope nothing can be freed
   *  later, so the object is counted as `untracked` for diagnostics. */
  track<T>(object: T): T {
    const scope = this.current;
    if (!scope) {
      if (isDeletable(object)) this.totals.untracked++;
      return object;
    }
    return scope.track(object);
  }

  /** Run `fn` inside a fresh scope. `try/finally` guarantees `dispose()`. */
  run<T>(label: string, fn: (scope: OcctScope) => T): T {
    const scope = new OcctScope(label);
    this.stack.push(scope);
    this.totals.scopes++;
    try {
      return fn(scope);
    } finally {
      this.stack.pop();
      const report = scope.dispose();
      this.totals.created += report.created;
      this.totals.deleted += report.deleted;
      this.totals.kept += report.kept;
      this.totals.failed += report.failed;
    }
  }

  snapshot(): OcctMemorySnapshot {
    const open = this.stack.reduce((sum, scope) => sum + scope.live, 0);
    return {
      scopes: this.totals.scopes,
      openScopes: this.stack.length,
      created: this.totals.created,
      deleted: this.totals.deleted,
      kept: this.totals.kept,
      failed: this.totals.failed,
      leaked: Math.max(0, this.totals.created - this.totals.deleted - this.totals.kept) + open,
      untracked: this.totals.untracked,
    };
  }

  reset(): void {
    this.totals = { created: 0, deleted: 0, kept: 0, failed: 0, scopes: 0, untracked: 0 };
  }
}

/** Wrap the Emscripten module so `new oc.X(...)` is tracked automatically.
 *
 *  Only constructors are trapped. Returning value objects from static helpers
 *  (`TopoDS.Edge_1`, `BRep_Tool.Triangulation`) is left to the caller because
 *  some of those handles alias memory owned by the shape and must not be
 *  deleted. */
export function wrapOcctConstructors(module: any, memory: OcctMemory): any {
  const wrapped = new WeakMap<object, unknown>();
  const make = (fn: object) => {
    const proxy = new Proxy(fn as (...args: unknown[]) => unknown, {
      construct(target, args) {
        const instance = Reflect.construct(target, args);
        memory.track(instance);
        return instance;
      },
    });
    wrapped.set(fn, proxy);
    return proxy;
  };
  return new Proxy(module, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      const existing = wrapped.get(value);
      if (existing) return existing;
      return make(value);
    },
  });
}
