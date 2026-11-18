import {Node} from "ts-morph";

// Short codes for why the extractor dropped a program. Open-ended specifics (an
// operator, a method name, a syntax kind) go in Rejection.detail.
export type ReasonCode =
    // statements
    | "braceless-then"            // if (c) f();
    | "braceless-else"            // if (c) { f(); } else g();
    | "non-boolean-if-condition"  // if (xs.length) { ... }
    | "var-decl"                  // var x = 1;
    | "multi-declarator"          // const a = 1, b = 2;
    | "destructuring-decl"        // const {a, b} = obj;
    | "uninitialized-decl"        // let x;
    | "for-loop"                  // for (const x of xs) { ... }
    | "while-loop"                // while (i < n) { ... }
    | "function-decl"             // function f(x) { return x; }
    | "class-decl"                // class Point { ... }
    | "enum-decl"                 // enum Color { Red, Green }
    | "namespace-decl"            // namespace Util { ... }
    | "switch-stmt"               // switch (x) { case 1: ... }
    | "try-stmt"                  // try { ... } catch (e) { ... }
    | "unsupported-statement"     // label: f();  (detail: the statement kind)
    // purity
    | "impure-assignment"         // x = 1;  obj.count += 1;
    | "impure-callee"             // xs.push(1);  console.log(x);
    | "impure-new"                // new Date()
    | "impure-throw"              // throw new Error("bad");
    | "impure-await"              // await fetch(url)
    // parameters
    | "destructuring-param"       // ({a, b}) => a - b
    | "rest-param"                // (...xs) => xs
    | "default-param"             // (a = 1) => a
    // calls
    | "optional-chain"            // f?.(x)  a?.b.c()
    | "unsupported-callee"        // this.f()  fs[0]()  h().g()
    | "bound-method-call"         // (x) => x.foo()  (x is $0)
    | "spread-arg"                // f(...xs)
    | "array-like-receiver"       // (t: [number, number]) => t.map(f)
    | "array-method-shape"        // xs.map(f, thisArg)  xs.reduce(f)
    // operators
    | "unsupported-unary-op"      // ~x  ++i
    | "unary-plus-non-number"     // +"42"
    | "union-operand"             // (x: string | number) => x + 1
    | "equality-type"             // a === b  (a: boolean, or number vs string)
    | "unsupported-binary-op"     // a ?? b  a % b
    // fallback
    | "unsupported-expression";   // `hi ${name}`  (detail: the expression kind)

export type Rejection = {reason: ReasonCode; detail: string | null; node: Node};
