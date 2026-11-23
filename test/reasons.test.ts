import test from "node:test"
import assert from "node:assert/strict"
import {convertProgram, explainProgram} from "../src/extract"
import {ReasonCode} from "../src/reasons"
import {parseFile} from "./helpers"

// [name, whole-file source, expected reason, expected detail, line of the reported node]
const rejections: [string, string, ReasonCode, string | null, number][] = [
    ["braceless then", "const g = (c: boolean) => {\n  if (c) f(1);\n};", "braceless-then", null, 2],
    ["braceless else", "const g = (c: boolean) => { if (c) { f(1); } else f(2); };", "braceless-else", null, 1],
    ["non-boolean cond", "const g = (n: number) => { if (n) { f(1); } };", "non-boolean-if-condition", null, 1],
    ["var", "var x = 1;", "var-decl", null, 1],
    ["var multi-declarator", "var a = 1, b = 2;", "var-decl", null, 1],
    ["multi-declarator destructured", "const a = 1,\n  {b} = o;", "destructuring-decl", null, 2],
    ["multi-declarator uninitialized", "let a = 1,\n  b;", "uninitialized-decl", null, 2],
    ["destructuring decl", "const {a} = o;", "destructuring-decl", null, 1],
    ["uninitialized", "let x: number;", "uninitialized-decl", null, 1],
    ["for-of", "for (const x of xs) { f(x); }", "for-loop", null, 1],
    ["while", "while (c) { f(1); }", "while-loop", null, 1],
    ["function decl", "function h(x: number) { return x; }", "function-decl", null, 1],
    ["class", "class A {}", "class-decl", null, 1],
    ["enum", "enum E { A }", "enum-decl", null, 1],
    ["namespace", "namespace N {}", "namespace-decl", null, 1],
    ["switch", "switch (x) { case 1: f(1); }", "switch-stmt", null, 1],
    ["try", "try { f(1); } catch { f(2); }", "try-stmt", null, 1],
    ["empty statement", "f(1);\n;", "unsupported-statement", "EmptyStatement", 2],
    ["file impure", "let x = 1;\nx = 2;", "impure-assignment", null, 2],
    ["closure impure (expr)", "const g = (xs: number[]) => xs.push(1);", "impure-callee", "push", 1],
    ["closure impure (block)", "const g = () => {\n  throw 1;\n};", "impure-throw", null, 2],
    ["new", "const s = new Set();", "impure-new", null, 1],
    ["destructuring param", "const g = ({a}: {a: number}) => a;", "destructuring-param", null, 1],
    ["rest param", "const g = (...xs: number[]) => xs;", "rest-param", null, 1],
    ["default param", "const g = (a = 1) => a;", "default-param", null, 1],
    ["optional call", "f?.(1);", "optional-chain", null, 1],
    ["optional dotted callee", "a?.b.c(1);", "optional-chain", null, 1],
    ["non-identifier callee root", "h().g(1);", "unsupported-callee", "CallExpression", 1],
    ["bound method", "const g = (s: string) => s.trim();", "bound-method-call", "trim", 1],
    ["spread arg", "f(...xs);", "spread-arg", null, 1],
    ["tuple receiver", "const g = (t: [number, number]) => t.map((x: number) => x);", "array-like-receiver", "map", 1],
    ["unseeded reduce", "const g = (xs: number[]) => xs.reduce((a: number, b: number) => a - b);", "array-method-shape", "reduce", 1],
    ["unary ~", "const g = (x: number) => ~x;", "unsupported-unary-op", "~", 1],
    ["unary + on string", "const g = (s: string) => +s;", "unary-plus-non-number", null, 1],
    ["union +", "const g = (x: string | number) => x + 1;", "union-operand", null, 1],
    ["object ===", "const g = (a: {x: number}, b: {x: number}) => a === b;", "equality-type", null, 1],
    ["boolean === (boolean is the union true | false)", "const g = (a: boolean, b: boolean) => a === b;", "union-operand", null, 1],
    ["modulo", "const g = (a: number, b: number) => a % b;", "unsupported-binary-op", "%", 1],
    ["property read", "const g = (o: {a: number}) => o.a;", "unsupported-expression", "PropertyAccessExpression", 1],
];

for (const [name, src, reason, detail, line] of rejections) {
    test(`rejection reason: ${name}`, () => {
        const result = explainProgram(parseFile(src));
        assert.equal(result.term, null);
        assert.equal(result.rejection?.reason, reason);
        assert.equal(result.rejection?.detail, detail);
        assert.equal(result.rejection?.node.getStartLineNumber(), line);
    });
}

test("innermost reason wins over the enclosing operator", () => {
    const r = explainProgram(parseFile("const g = (x: number) => x % ((y: any) => y.trim());"));
    assert.equal(r.rejection?.reason, "bound-method-call");
});

test("first rejection in a file wins", () => {
    const r = explainProgram(parseFile("var a = 1;\nfor (;;) {}"));
    assert.equal(r.rejection?.reason, "var-decl");
});

test("rejection slot resets between files", () => {
    explainProgram(parseFile("var a = 1;"));
    assert.deepEqual(explainProgram(parseFile("const g = (x: number) => x - 1;")),
        {term: "(define (lam1 (num_sub $0 1)) pass)", rejection: null});
});

test("explainProgram agrees with convertProgram on accepted files", () => {
    const src = "const f = (a: number, b: number) => a - b;\nf(1, 2);";
    assert.equal(explainProgram(parseFile(src)).term, convertProgram(parseFile(src)));
});
