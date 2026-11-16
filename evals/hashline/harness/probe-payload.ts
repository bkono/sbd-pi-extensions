/* biome-ignore-all lint/suspicious/noExplicitAny: eval-only probe takes Pi's extension API untyped so the harness needs no Pi dev dependency. */
// Eval-only, read-only Pi extension: writes every provider payload to $EVAL_PAYLOAD_DIR/req-NNN.json
// so consecutive requests can be diffed at a cache drop. Never changes the payload.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export default function probePayload(pi: any): void {
  const dir = process.env.EVAL_PAYLOAD_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  let n = 0;
  pi.on("before_provider_request", (event: any) => {
    try {
      writeFileSync(
        path.join(dir, `req-${String(n++).padStart(3, "0")}.json`),
        JSON.stringify(event.payload),
      );
    } catch {
      // diagnostic only
    }
    return undefined;
  });
}
