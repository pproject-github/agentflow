import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const componentPath = new URL("../builtin/web-ui/src/components/ReleaseNodeInspector.jsx", import.meta.url);

test("release node inspector exposes read-only completed and editable pending modes", () => {
  assert.equal(fs.existsSync(componentPath), true);
  const source = fs.readFileSync(componentPath, "utf8");
  assert.match(source, /ReleaseNodeInspector/);
  assert.match(source, /completed/);
  assert.match(source, /readOnly|disabled/);
  assert.match(source, /最大化|maximize/);
  assert.match(source, /日志/);
  assert.match(source, /输出/);
  assert.match(source, /onSave/);
  assert.match(source, /onPreview/);
});
