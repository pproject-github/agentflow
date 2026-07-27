import assert from "node:assert/strict";
import test from "node:test";

import {
  appVersionSnoozeKey,
  hasAppVersionChanged,
  normalizeAppVersion,
} from "../builtin/web-ui/src/appVersion.js";

test("normalizes app versions before comparing client and server", () => {
  assert.equal(normalizeAppVersion(" v0.1.104 "), "0.1.104");
  assert.equal(hasAppVersionChanged("0.1.104", "v0.1.104"), false);
  assert.equal(hasAppVersionChanged("0.1.103", "0.1.104"), true);
});

test("ignores incomplete version responses and scopes snooze by version pair", () => {
  assert.equal(hasAppVersionChanged("", "0.1.104"), false);
  assert.equal(hasAppVersionChanged("0.1.104", ""), false);
  assert.equal(
    appVersionSnoozeKey("v0.1.103", "0.1.104"),
    "agentflow.app-version.snooze:0.1.103:0.1.104",
  );
});
