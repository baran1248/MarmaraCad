const out = document.getElementById("out")!;
const worker = new Worker(new URL("./probe2.worker.ts", import.meta.url), { type: "module" });
const lines: string[] = [];
function log(s: string) {
  lines.push(s);
  out.textContent = lines.join("\n");
}

worker.onmessage = (e) => {
  const d = e.data;
  if (d.type === "ready") {
    log(`OCCT ready in ${d.bootMs} ms`);
    if (d.found) {
      for (const [k, v] of Object.entries(d.found)) log(`\n## ${k}\n${(v as string[]).join("\n")}`);
    }
    worker.postMessage({ type: "selftest" });
  } else if (d.type === "selftest") {
    log(`\nSELFTEST\n${d.log.join("\n")}`);
    (window as any).__probeDone = true;
  }
};
worker.onerror = (e) => {
  log("WORKER ERROR: " + e.message);
  (window as any).__probeDone = true;
};
worker.postMessage({ type: "boot" });
