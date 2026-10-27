import assert from "node:assert/strict";
import { installBackgroundFocusGuard } from "../web/lib/xzg_background_focus.mjs";

let focused = false;
let elementCalls = 0;
let windowCalls = 0;
const events = {};
const reports = [];
class Element {
    focus() { elementCalls++; return "focused"; }
}
const win = { HTMLElement: Element, focus() { windowCalls++; } };
const doc = { hasFocus: () => focused, addEventListener(name, fn) { events[name] = fn; } };
installBackgroundFocusGuard(win, doc, (...args) => reports.push(args));
const canvas = Object.assign(new Element(), { tagName: "CANVAS", id: "graph", className: "" });
canvas.focus();
win.focus();
assert.equal(elementCalls, 0);
assert.equal(windowCalls, 0);
assert.equal(reports.length, 2);
assert.match(reports[0][1], /CANVAS/);
assert.match(reports[0][2], /test_background_focus/);
focused = true;
assert.equal(canvas.focus(), "focused");
win.focus();
assert.equal(elementCalls, 1);
assert.equal(windowCalls, 1);
focused = false;
events.pointerdown({ isTrusted: false });
canvas.focus();
assert.equal(elementCalls, 1);
events.pointerdown({ isTrusted: true });
canvas.focus();
assert.equal(elementCalls, 2);
await Promise.resolve();
canvas.focus();
assert.equal(elementCalls, 2);
console.log("Background focus: canvas and window blocked, foreground and trusted input preserved.");
