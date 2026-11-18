import test from "node:test";
import assert from "node:assert/strict"
import {findImpurity} from "../src/purity"
import {ReasonCode} from "../src/reasons"
import {parseExpr, parseStatement} from "./helpers";

test("pure arithmetic expression", () => {
    assert.equal(findImpurity(parseExpr("x + 1")), null);
});

test("pure ternary expression", () => {
    assert.equal(findImpurity(parseExpr("x > 0 ? x : 0")), null);
});

test("console.log call is impure", () => {
    assert.notEqual(findImpurity(parseExpr("console.log(x)")), null);
});

test("console.error call is impure", () => {
    assert.notEqual(findImpurity(parseExpr("console.error(x)")), null);
});

test("array push call is impure", () => {
    assert.notEqual(findImpurity(parseExpr("xs.push(x)")), null);
});

test("array splice call is impure", () => {
    assert.notEqual(findImpurity(parseExpr("xs.splice(0, 1)")), null);
});

test("array forEach call is impure", () => {
    assert.notEqual(findImpurity(parseExpr("xs.forEach(x => x)")), null);
});

test("new expression is impure", () => {
    assert.notEqual(findImpurity(parseExpr("new Foo()")), null);
});

test("plain reassignment is impure", () => {
    assert.notEqual(findImpurity(parseStatement("x = 1;")), null);
});

test("property assignment is impure", () => {
    assert.notEqual(findImpurity(parseStatement("obj.prop = x;")), null);
});

test("throw statement is impure", () => {
    assert.notEqual(findImpurity(parseStatement("throw new Error('x');")), null);
});

test("await expression is impure", () => {
    assert.notEqual(findImpurity(parseStatement("async function f() { await g(); }")), null);
});

test("impurity nested inside a ternary branch is detected", () => {
    assert.notEqual(findImpurity(parseExpr("cond ? console.log(x) : y")), null);
});

test("push on a non-array receiver is still flagged (name-based heuristic, documented limitation)", () => {
    assert.notEqual(findImpurity(parseExpr("obj.push(x)")), null);
});

test("impurity nested inside an if-statement's then-branch is detected", () => {
    assert.notEqual(findImpurity(parseStatement("if (c) { console.log(x); }")), null);
});
const impurityCases: [string, string, ReasonCode, string | null, string][] = [
    // [name, expression source, reason, detail, text of the reported node]
    ["assignment", "x = 1", "impure-assignment", null, "x = 1"],
    ["console.log", "console.log(x)", "impure-callee", "console.log", "console.log(x)"],
    ["mutating method", "xs.push(1)", "impure-callee", "push", "xs.push(1)"],
    ["new", "new Set()", "impure-new", null, "new Set()"],
    ["await", "async () => await f()", "impure-await", null, "await f()"],
];

for (const [name, src, reason, detail, text] of impurityCases) {
    test(`findImpurity: ${name}`, () => {
        const hit = findImpurity(parseExpr(src));
        assert.equal(hit?.reason, reason);
        assert.equal(hit?.detail, detail);
        assert.equal(hit?.node.getText(), text);
    });
}

test("findImpurity: throw statement", () => {
    assert.equal(findImpurity(parseStatement("throw 1;"))?.reason, "impure-throw");
});

test("findImpurity: pure expression returns null", () => {
    assert.equal(findImpurity(parseExpr("x > 0 ? x : 0")), null);
});

test("findImpurity: reports the first impure node in source order", () => {
    assert.equal(findImpurity(parseExpr("f(xs.push(1), console.log(2))"))?.detail, "push");
});
