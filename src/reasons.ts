import {Node} from "ts-morph";

// Short codes for why the extractor dropped a program. Open-ended specifics (an
// operator, a method name, a syntax kind) go in Rejection.detail.
export type ReasonCode =
    // statements
    | "braceless-then"
    | "braceless-else"
    | "non-boolean-if-condition"
    | "var-decl"
    | "multi-declarator"
    | "destructuring-decl"
    | "uninitialized-decl"
    | "for-loop"
    | "while-loop"
    | "function-decl"
    | "class-decl"
    | "enum-decl"
    | "namespace-decl"
    | "switch-stmt"
    | "try-stmt"
    | "unsupported-statement"
    // purity
    | "impure-assignment"
    | "impure-callee"
    | "impure-new"
    | "impure-throw"
    | "impure-await"
    // parameters
    | "destructuring-param"
    | "rest-param"
    | "default-param"
    // calls
    | "optional-chain"
    | "unsupported-callee"
    | "bound-method-call"
    | "spread-arg"
    | "array-like-receiver"
    | "array-method-shape"
    // operators
    | "unsupported-unary-op"
    | "unary-plus-non-number"
    | "union-operand"
    | "equality-type"
    | "unsupported-binary-op"
    // fallback
    | "unsupported-expression";

export type Rejection = {reason: ReasonCode; detail: string | null; node: Node};
