import test from "node:test";
import assert from "node:assert/strict";
import { isValidScribdUrl, parsePageSelection } from "./validate.js";
test("accepts scribd doc url", () => { assert.equal(isValidScribdUrl("https://www.scribd.com/document/123456789/Sample-Doc"), true); });
test("rejects non-scribd", () => { assert.equal(isValidScribdUrl("https://evil.com/x"), false); });
test("pages all/1-3/5", () => {
  assert.deepEqual(parsePageSelection("all", 10), [0,1,2,3,4,5,6,7,8,9]);
  assert.deepEqual(parsePageSelection("1-3", 10), [0,1,2]);
  assert.deepEqual(parsePageSelection("5", 10), [4]);
});
test("pages out of bounds throws", () => { assert.throws(() => parsePageSelection("99", 5)); });
