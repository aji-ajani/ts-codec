import {Node} from "ts-morph";
import {ReasonCode} from "./reasons";

export type Outcome = "kept" | "rejected" | "too-small" | "duplicate" | "parse-error" | "crash";

// One row per input file.
export type ReportEntry = {
    path: string;
    outcome: Outcome;
    reason: ReasonCode | "unrecorded" | null;
    detail: string | null;
    line: number | null;
    snippet: string | null;
    termSize: number | null;
    duplicateOf: string | null;
    message: string | null;
};

const SNIPPET_MAX = 80;

export function snippetOf(node: Node): string {
    const text = node.getText().replace(/\s+/g, " ").trim();
    return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text;
}
