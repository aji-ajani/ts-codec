import {Node, SyntaxKind, Statement, VariableDeclarationKind, SourceFile, IfStatement, ParameterDeclaration, ts} from "ts-morph"
import {Scope, lookup, pushParams} from "./scope"
import {findImpurity} from "./purity"
import {ReasonCode, Rejection} from "./reasons"

// The first rejection recorded since the last explainProgram call. Because no caller ever recovers from a
// child's null, the first recorded rejection is always the one that caused the whole program to be dropped.
let firstRejection: Rejection | null = null;

function reject(reason: ReasonCode, node: Node, detail: string | null = null): null {
    if (firstRejection === null) firstRejection = {reason, detail, node};
    return null;
}

export type ProgramResult = {term: string; rejection: null} | {term: null; rejection: Rejection | null};

// convertProgram plus why it returned null. A null term with a null rejection means some null
// site forgot to call `reject` - an extractor bug, reported upstream as "unrecorded".
export function explainProgram(sourceFile: SourceFile): ProgramResult {
    firstRejection = null;
    const term = convertProgram(sourceFile);
    return term === null ? {term: null, rejection: firstRejection} : {term, rejection: null};
}

const ARRAY_OPS: Record<string, string> = {
    map: "array_map",
    filter: "array_filter",
    flatMap: "array_flatMap",
    find: "array_find",
    some: "array_some",
    every: "array_every",
    // reduce is handled separately
};

function isArrayLikeReceiver(type: ReturnType<Node["getType"]>): boolean {
    // Ownership test for the array-method branch. Widened beyond plain `.isArray()` so tuple
    // and union-of-array receivers are still claimed (and correctly dropped on a call-shape
    // mismatch) rather than falling through to a second `app` encoding of the same call. The
    // *encoding* path below still requires `.isArray()` exactly as before — this only affects
    // who owns the call, not which receivers get `array_*` operators (see extractor-design-decisions.md).
    if (type.isArray() || type.isTuple()) return true;
    if (type.isUnion()) return type.getUnionTypes().some((t) => t.isArray() || t.isTuple());
    return false;
}

function paramReason(param: ParameterDeclaration): ReasonCode | null {
    // Destructuring, rest, and defaulted params have no plain binder, so there's no way to encode them yet.
    if (!Node.isIdentifier(param.getNameNode())) return "destructuring-param"; // object, array, and renamed patterns
    if (param.isRestParameter()) return "rest-param";
    if (param.getInitializer() !== undefined) return "default-param";
    return null;
}

function statementReason(stmt: Statement): {reason: ReasonCode; detail: string | null} {
    if (Node.isForStatement(stmt) || Node.isForInStatement(stmt) || Node.isForOfStatement(stmt)) return {reason: "for-loop", detail: null};
    if (Node.isWhileStatement(stmt) || Node.isDoStatement(stmt)) return {reason: "while-loop", detail: null};
    if (Node.isFunctionDeclaration(stmt)) return {reason: "function-decl", detail: null};
    if (Node.isClassDeclaration(stmt)) return {reason: "class-decl", detail: null};
    if (Node.isEnumDeclaration(stmt)) return {reason: "enum-decl", detail: null};
    if (Node.isModuleDeclaration(stmt)) return {reason: "namespace-decl", detail: null};
    if (Node.isSwitchStatement(stmt)) return {reason: "switch-stmt", detail: null};
    if (Node.isTryStatement(stmt)) return {reason: "try-stmt", detail: null};
    return {reason: "unsupported-statement", detail: stmt.getKindName()};
}

function reachableStatements(statements: Statement[]): Statement[] {
    const returnIndex = statements.findIndex((s) => Node.isReturnStatement(s));
    return returnIndex === -1 ? statements : statements.slice(0, returnIndex + 1);
}

function blockImpurity(statements: Statement[]): Rejection | null {
    for (const stmt of reachableStatements(statements)) {
        const hit = statementImpurity(stmt);
        if (hit !== null) return hit;
    }
    return null;
}

function statementImpurity(stmt: Statement): Rejection | null {
    if (!Node.isIfStatement(stmt)) return findImpurity(stmt);

    const condHit = findImpurity(stmt.getExpression());
    if (condHit !== null) return condHit;

    const thenStmt = stmt.getThenStatement();
    if (!Node.isBlock(thenStmt)) return findImpurity(stmt); // braceless then — conversion rejects it anyway

    const thenHit = blockImpurity(thenStmt.getStatements());
    if (thenHit !== null) return thenHit;

    const elseStmt = stmt.getElseStatement();
    if (elseStmt === undefined) return null;
    if (Node.isIfStatement(elseStmt)) return statementImpurity(elseStmt);
    if (Node.isBlock(elseStmt)) return blockImpurity(elseStmt.getStatements());
    return findImpurity(elseStmt); // braceless else — conversion rejects it anyway
}

function convertElseBranch(stmt: Statement | undefined, scope: Scope): string | null {
    if (stmt === undefined) return "pass"; // no else clause

    if (Node.isIfStatement(stmt)) return convertIfStatement(stmt, scope); // else if

    if (Node.isBlock(stmt)) return convertBlockStatements(stmt.getStatements(), 0, scope);

    return reject("braceless-else", stmt); // braceless else (e.g. `else foo();`) not supported
}

function convertIfStatement(stmt: IfStatement, scope: Scope): string | null {
    const condNode = stmt.getExpression();
    const condType = condNode.getType();
    if (!condType.isBoolean() && !condType.isBooleanLiteral()) return reject("non-boolean-if-condition", condNode); // non-boolean (incl. unions) — don't guess a truthiness coercion

    const cond = convert(condNode, scope);
    if (cond === null) return null;

    const thenStmt = stmt.getThenStatement();
    if (!Node.isBlock(thenStmt)) return reject("braceless-then", thenStmt); // braceless then (e.g. `if (c) foo();`) not supported

    const thenChain = convertBlockStatements(thenStmt.getStatements(), 0, scope);
    if (thenChain === null) return null;

    const elseChain = convertElseBranch(stmt.getElseStatement(), scope);
    if (elseChain === null) return null;

    return `(if ${cond} ${thenChain} ${elseChain})`;
}

function convertBlockStatements(statements: Statement[], index: number, scope: Scope): string | null {
    if (index === statements.length) return "pass"; // ran out of statements — no explicit return

    const stmt = statements[index];

    if (Node.isReturnStatement(stmt)) {
        // Terminal unconditionally: the only other source of control transfer is `if`, whose
        // branches recurse through this same function — so anything textually after a `return`
        // is provably unreachable, dropped here rather than converted, regardless of what (if
        // anything) follows in `statements`.
        const returnExpr = stmt.getExpression();
        if (returnExpr === undefined) return "(return pass)"; // bare `return;`

        const value = convert(returnExpr, scope);
        if (value === null) return null;
        return `(return ${value})`;
    }

    if (Node.isVariableStatement(stmt)) {
        if (stmt.getDeclarationKind() === VariableDeclarationKind.Var) return reject("var-decl", stmt); // var not supported

        const declarations = stmt.getDeclarations();
        if (declarations.length !== 1) return reject("multi-declarator", stmt); // multi-declarator statements not supported

        const nameNode = declarations[0].getNameNode();
        if (!Node.isIdentifier(nameNode)) return reject("destructuring-decl", nameNode); // destructuring not supported

        const initializer = declarations[0].getInitializer();
        if (initializer === undefined) return reject("uninitialized-decl", declarations[0]); // no value to bind

        const value = convert(initializer, scope);
        if (value === null) return null;

        const rest = convertBlockStatements(statements, index + 1, pushParams([nameNode.getText()], scope));
        if (rest === null) return null;
        return `(define ${value} ${rest})`;
    }

    if (Node.isExpressionStatement(stmt)) {
        const value = convert(stmt.getExpression(), scope);
        if (value === null) return null;

        const rest = convertBlockStatements(statements, index + 1, scope);
        if (rest === null) return null;
        return `(seq ${value} ${rest})`;
    }

    if (Node.isIfStatement(stmt)) {
        const ifTerm = convertIfStatement(stmt, scope);
        if (ifTerm === null) return null;

        if (index + 1 === statements.length) return ifTerm; // last statement — no seq wrapper, mirrors a terminal return's value

        const rest = convertBlockStatements(statements, index + 1, scope);
        if (rest === null) return null;
        return `(seq ${ifTerm} ${rest})`;
    }

    if (
        Node.isImportDeclaration(stmt) ||
        Node.isImportEqualsDeclaration(stmt) ||
        Node.isExportDeclaration(stmt) ||
        Node.isTypeAliasDeclaration(stmt) ||
        Node.isInterfaceDeclaration(stmt)
    ) {
        // Erased at compile time (or, for imports, no DSL concept of module loading) — no
        // runtime value to encode, so skip silently rather than rejecting the whole file.
        return convertBlockStatements(statements, index + 1, scope);
    }

    if (Node.isExportAssignment(stmt)) {
        // Not terminal like return: export default/export = does not stop module evaluation,
        // so statements after it still execute and must still be converted, not dropped.
        const value = convert(stmt.getExpression(), scope);
        if (value === null) return null;

        const rest = convertBlockStatements(statements, index + 1, scope);
        if (rest === null) return null;
        return `(seq ${value} ${rest})`;
    }

    // unsupported statement kind (for/while/try/function/class/enum/namespace, ...); throw never
    // reaches here because the purity gate rejects it first
    const {reason, detail} = statementReason(stmt);
    return reject(reason, stmt, detail);
}

export function convertProgram(sourceFile: SourceFile): string | null {
    const statements = sourceFile.getStatements();
    const impurity = blockImpurity(statements);
    if (impurity !== null) return reject(impurity.reason, impurity.node, impurity.detail);
    return convertBlockStatements(statements, 0, []);
}

function dottedSymbol(node: Node, scope: Scope): string | null {
    // A property-access callee encodes as one opaque free symbol ("Math.floor", "R.map").
    // Built by walking the chain rather than from getText(), so optional chaining and
    // incidental whitespace/comments can never yield two spellings of the same symbol.
    const segments: string[] = [];
    let current: Node = node;

    while (Node.isPropertyAccessExpression(current)) {
        if (current.compilerNode.questionDotToken !== undefined) return reject("optional-chain", current); // a?.b.c
        segments.unshift(current.getName());
        current = current.getExpression();
    }

    if (!Node.isIdentifier(current)) return reject("unsupported-callee", current, current.getKindName()); // this.f(), fs[0].g(), h().g() — no symbol to name

    const root = current.getText();
    if (lookup(root, scope) !== root) return reject("bound-method-call", node, segments[segments.length - 1]); // bound root: "$0.foo" is not a spellable symbol

    return [root, ...segments].join(".");
}

function convertCallee(callee: Node, scope: Scope): string | null {
    if (Node.isPropertyAccessExpression(callee)) return dottedSymbol(callee, scope);
    return convert(callee, scope); // Identifier, parenthesized expression, inline arrow (IIFE), or a nested call.
}

export function convert(node: Node, scope: Scope): string | null {
    if (Node.isNumericLiteral(node)) {
        return node.getText();
    }

    if (Node.isStringLiteral(node)) {
        return JSON.stringify(node.getLiteralValue());
    }

    if (Node.isIdentifier(node)) {
        return lookup(node.getText(), scope);
    }

    if (Node.isTrueLiteral(node) || Node.isFalseLiteral(node)) {
        return node.getText(); // "true" / "false"
    }

    if (Node.isParenthesizedExpression(node)) {
        // Parens carry no semantic content beyond the grouping the parser has already
        // applied, so they are ignored.
        return convert(node.getExpression(), scope);
    }

    if (Node.isPrefixUnaryExpression(node)) {
        const operatorToken = node.getOperatorToken();
        const operand = convert(node.getOperand(), scope);
        if (operand === null) return null;

        switch (operatorToken) {
            case SyntaxKind.ExclamationToken:
                return `(bool_not ${operand})`;
            case SyntaxKind.MinusToken:
                return `(num_neg ${operand})`;
            case SyntaxKind.PlusToken: {
                const operandType = node.getOperand().getType();
                if (operandType.isUnion()) return reject("union-operand", node.getOperand()); // ambiguous - don't guess
                if (!operandType.isNumber() && !operandType.isNumberLiteral()) return reject("unary-plus-non-number", node.getOperand());
                return `(num_pos ${operand})`;
            }
            default:
                return reject("unsupported-unary-op", node, ts.tokenToString(operatorToken) ?? SyntaxKind[operatorToken]); // other prefix unary operators not supported yet
        }
    }

    if (Node.isConditionalExpression(node)) {
        const cond = convert(node.getCondition(), scope);
        const whenTrue = convert(node.getWhenTrue(), scope);
        const whenFalse = convert(node.getWhenFalse(), scope);
        if (cond === null || whenTrue === null || whenFalse === null) return null;
        return `(ternary ${cond} ${whenTrue} ${whenFalse})`;
    }

    if (Node.isBinaryExpression(node)) {
        const left = convert(node.getLeft(), scope);
        const right = convert(node.getRight(), scope);

        if (left === null || right === null) return null; // propagate parse failures upwards

        switch (node.getOperatorToken().getText()) {
            case "+": {
                const leftType = node.getLeft().getType();
                if (leftType.isUnion()) return reject("union-operand", node.getLeft()); // ambiguous num_add/str_concat - don't guess
                if (leftType.isString() || leftType.isStringLiteral()) return `(str_concat ${left} ${right})`;
                return `(num_add ${left} ${right})`;
            }
            case "-":
                return `(num_sub ${left} ${right})`;
            case "*":
                return `(num_mul ${left} ${right})`;
            case "/":
                return `(num_div ${left} ${right})`;
            case ">":
                return `(num_gt ${left} ${right})`;
            case "<":
                return `(num_lt ${left} ${right})`;
            case ">=":
                return `(num_gte ${left} ${right})`;
            case "<=":
                return `(num_lte ${left} ${right})`;
            case "===": {
                const leftType = node.getLeft().getType();
                const rightType = node.getRight().getType();
                if (leftType.isUnion() || rightType.isUnion()) return reject("union-operand", node); // ambiguous - don't guess
                if ((leftType.isNumber() || leftType.isNumberLiteral()) && (rightType.isNumber() || rightType.isNumberLiteral())) return `(num_eq ${left} ${right})`;
                if ((leftType.isString() || leftType.isStringLiteral()) && (rightType.isString() || rightType.isStringLiteral())) return `(str_eq ${left} ${right})`;
                return reject("equality-type", node); // mismatched or otherwise untyped operands
            }
            case "&&":
                return `(bool_and ${left} ${right})`;
            case "||":
                return `(bool_or ${left} ${right})`;
            default:
                return reject("unsupported-binary-op", node, node.getOperatorToken().getText()); // other binary expressions not supported yet
        }
    }

    if (Node.isArrowFunction(node)) {
        for (const param of node.getParameters()) {
            const reason = paramReason(param);
            if (reason !== null) return reject(reason, param);
        }
        const params = node.getParameters().map((p) => p.getName());
        const body: Node = node.getBody();

        if (Node.isBlock(body)) {
            const statements = reachableStatements(body.getStatements());
            const impurity = blockImpurity(statements);
            if (impurity !== null) return reject(impurity.reason, impurity.node, impurity.detail); // impure closures are not DSR-eligible; dead code after `return` (including inside if-branches) is excluded
            const inner = convertBlockStatements(statements, 0, pushParams(params, scope));
            if (inner === null) return null;
            return `(lam${params.length} ${inner})`;
        }

        const impurity = findImpurity(body);
        if (impurity !== null) return reject(impurity.reason, impurity.node, impurity.detail); // impure closures are not DSR-eligible
        const inner = convert(body, pushParams(params, scope));
        if (inner === null) return null; // propagate body parse failure upwards
        return `(lam${params.length} ${inner})`
    }

    if (Node.isCallExpression(node)) {
        if (node.compilerNode.questionDotToken !== undefined) return reject("optional-chain", node); // f?.(x)

        const args = node.getArguments();
        const spread = args.find((arg) => Node.isSpreadElement(arg));
        if (spread !== undefined) return reject("spread-arg", spread); // no DSL term for splatting an array into a parameter list

        const callee = node.getExpression();

        if (Node.isPropertyAccessExpression(callee)) {
            const receiverNode = callee.getExpression();
            const methodName = callee.getName();

            if (isArrayLikeReceiver(receiverNode.getType()) && (Object.hasOwn(ARRAY_OPS, methodName) || methodName === "reduce")) {
                const receiver = convert(receiverNode, scope);
                if (receiver === null) return null;

                if (Object.hasOwn(ARRAY_OPS, methodName) && args.length === 1 && receiverNode.getType().isArray()) {
                    const callback = convert(args[0], scope);
                    if (callback === null) return null;
                    return `(${ARRAY_OPS[methodName]} ${receiver} ${callback})`;
                }

                if (methodName === "reduce" && args.length === 2 && receiverNode.getType().isArray()) {
                    const callback = convert(args[0], scope);
                    const init = convert(args[1], scope);
                    if (callback === null || init === null) return null;
                    return `(array_reduce ${receiver} ${callback} ${init})`;
                }

                // This branch owns the call: the receiver is an array and the method is one
                // it handles, so a call-shape mismatch (a thisArg, an unseeded reduce) drops
                // the call rather than falling through to a second encoding as `app`.
                if (!receiverNode.getType().isArray()) return reject("array-like-receiver", node, methodName); // tuple or union-of-array receiver
                return reject("array-method-shape", node, methodName); // thisArg, unseeded reduce, ...
            }
        }

        const fn = convertCallee(callee, scope);
        if (fn === null) return null;

        const encodedArgs: string[] = [];
        for (const arg of args) {
            const encoded = convert(arg, scope);
            if (encoded === null) return null; // propagate argument parse failures upwards
            encodedArgs.push(encoded);
        }

        return `(app ${[fn, ...encodedArgs].join(" ")})`;
    }

    return reject("unsupported-expression", node, node.getKindName());
}