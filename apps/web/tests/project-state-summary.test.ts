import assert from "node:assert/strict";
import test from "node:test";
import snapshot from "../src/lib/admin/project-state-summary.json";

test("project data snapshot contains only approved aggregate fields", () => {
  assert.match(snapshot.snapshotDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(Object.keys(snapshot.counts).sort(), [
    "checkpoints",
    "dataSources",
    "decisions",
    "rssFeeds",
    "tasks",
  ]);
  assert.ok(Object.values(snapshot.counts).every((count) => Number.isSafeInteger(count) && count >= 0));
});