import {Node} from "ts-morph";
import {Rejection} from "./reasons";

const ASSIGNMENT_OPERATORS = new Set([
    "=", "+=", "-=", "*=", "/=", "%=", "**=", "&=", "|=", "^=", "<<=", ">>=", ">>>=", "&&=", "||=", "??=",
]);

const IMPURE_METHOD_NAMES = new Set([
    "push", "pop", "splice", "shift", "unshift", "sort", "reverse", "forEach",
]);

// Returns the first impure node in depth-first source order (with why it is impure), or null
// if the subtree is pure.
export function findImpurity(node: Node): Rejection | null {
    let hit: Rejection | null = null;

    function visit(n: Node): void {
        if (hit !== null) return;

        if (Node.isAwaitExpression(n)) {
            hit = {reason: "impure-await", detail: null, node: n};
            return;
        }
        if (Node.isThrowStatement(n)) {
            hit = {reason: "impure-throw", detail: null, node: n};
            return;
        }
        if (Node.isNewExpression(n)) {
            hit = {reason: "impure-new", detail: null, node: n};
            return;
        }

        if (Node.isBinaryExpression(n) && ASSIGNMENT_OPERATORS.has(n.getOperatorToken().getText())) {
            // This also catches PropertyAccessExpressions for free
            hit = {reason: "impure-assignment", detail: null, node: n};
            return;
        }

        if (Node.isCallExpression(n)) {
            const callee = n.getExpression();
            if (Node.isPropertyAccessExpression(callee)) {
                const methodName = callee.getName();
                const receiverText = callee.getExpression().getText();
                const isConsoleCall = receiverText === "console" && (methodName === "log" || methodName === "error");
                if (isConsoleCall || IMPURE_METHOD_NAMES.has(methodName)) {
                    hit = {reason: "impure-callee", detail: isConsoleCall ? `console.${methodName}` : methodName, node: n};
                    return;
                }
            }
        }

        n.forEachChild(visit);
    }

    visit(node);
    return hit;
}
