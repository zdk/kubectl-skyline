import test from "node:test";
import assert from "node:assert/strict";
import { ageHTML } from "../common.js";

const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();

test("ageHTML flags fresh pods", () => {
  assert.match(ageHTML(ago(1)), /class="age-new"/);
  assert.match(ageHTML(ago(30)), /class="age-recent"/);
  assert.equal(ageHTML(ago(300)), "5h");
});
