import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("Panel browser code does not persist or read a human session token", () => {
  const files = [
    "src/lib/api.ts",
    "src/App.tsx",
    "src/components/LoginPage.tsx",
    "src/components/SettingsView.tsx",
  ];
  const source = files.map((file) => readFileSync(path.resolve(file), "utf8")).join("\n");
  assert.doesNotMatch(source, /localStorage\.(?:getItem|setItem|removeItem)\(['\"](?:token|userRole)['\"]\)/);
  assert.doesNotMatch(source, /Authorization\s*:\s*[`'"]Bearer/);
  assert.match(readFileSync(path.resolve("src/lib/api.ts"), "utf8"), /credentials:\s*['\"]same-origin['\"]/);
});
