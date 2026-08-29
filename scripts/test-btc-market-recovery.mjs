import { shouldRecoverMarketSnapshot } from "./btc-market-recovery-lib.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let total = 0, failed = 0;
function check(name, ok, detail = "") {
  total++;
  if (ok) console.log(`PASS ${String(total).padStart(2, "0")} ${name}`);
  else {
    failed++;
    console.error(`FAIL ${String(total).padStart(2, "0")} ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

const nowMs = Date.parse("2026-08-29T12:00:00Z");

function runCaptureWith(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "btc-market-capture-"));
  const snapshot = path.join(dir, "snapshot.json");
  const envFile = path.join(dir, "env.txt");
  fs.writeFileSync(snapshot, content);
  const output = execFileSync(process.execPath, ["scripts/capture-btc-market-before.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, BTC_MARKET_SNAPSHOT: snapshot, GITHUB_ENV: envFile },
    encoding: "utf8"
  });
  return { output, env: fs.readFileSync(envFile, "utf8") };
}

{
  const result = shouldRecoverMarketSnapshot({
    nowMs,
    snapshot: { generated_at: "2026-08-29T10:00:00Z" }
  });
  check("missed cron at stale threshold triggers recovery", result.shouldRecover && result.ageMinutes === 120, JSON.stringify(result));
}

{
  const result = shouldRecoverMarketSnapshot({
    nowMs,
    snapshot: { generated_at: "2026-08-29T10:01:00Z" }
  });
  check("fresh enough snapshot does not trigger recovery", !result.shouldRecover && !result.stale, JSON.stringify(result));
}

{
  const result = shouldRecoverMarketSnapshot({
    nowMs,
    snapshot: { generated_at: "2026-08-29T09:00:00Z" },
    lastAttemptAt: "2026-08-29T11:45:00Z"
  });
  check("recent recovery attempt is throttled to avoid duplicate runs", !result.shouldRecover && result.throttled, JSON.stringify(result));
}

{
  const result = shouldRecoverMarketSnapshot({
    nowMs,
    snapshot: { generated_at: "not-a-date" },
    lastAttemptAt: "2026-08-29T11:00:00Z"
  });
  check("invalid snapshot timestamp triggers recovery outside throttle window", result.shouldRecover && result.stale, JSON.stringify(result));
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "btc-market-recovery-"));
  const snapshot = path.join(dir, "snapshot.json");
  fs.writeFileSync(snapshot, JSON.stringify({ generated_at: "2026-08-29T12:01:00.000Z" }));
  let ok = false;
  try {
    execFileSync(process.execPath, ["scripts/verify-btc-market-freshness.mjs", "after-collect"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        BTC_MARKET_SNAPSHOT: snapshot,
        BTC_MARKET_BEFORE_GENERATED_AT: "not-a-date",
        BTC_MARKET_ALLOW_INVALID_BEFORE: "true"
      },
      encoding: "utf8"
    });
    ok = true;
  } catch {}
  check("recovery verifier accepts a valid new timestamp after invalid stale snapshot", ok);
}

{
  const result = runCaptureWith(JSON.stringify({ generated_at: "2026-08-29T11:59:00.000Z" }));
  check("updater captures valid previous generated_at without invalid-before flag", result.env.includes("BTC_MARKET_BEFORE_GENERATED_AT=2026-08-29T11:59:00.000Z") && !result.env.includes("BTC_MARKET_ALLOW_INVALID_BEFORE"), result.env);
}

{
  const result = runCaptureWith(JSON.stringify({ generated_at: "not-a-date" }));
  check("updater tolerates invalid previous generated_at and enables self-recovery", result.env.includes("BTC_MARKET_BEFORE_GENERATED_AT=\n") && result.env.includes("BTC_MARKET_ALLOW_INVALID_BEFORE=true"), result.env);
}

{
  const result = runCaptureWith("{not-json");
  check("updater tolerates malformed pre-run btc-market.json and enables self-recovery", result.env.includes("BTC_MARKET_BEFORE_GENERATED_AT=\n") && result.env.includes("BTC_MARKET_ALLOW_INVALID_BEFORE=true"), result.env);
}

console.log(`\n${total - failed}/${total} BTC market recovery tests passed`);
process.exit(failed ? 1 : 0);
