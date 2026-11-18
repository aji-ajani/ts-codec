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

export function toJsonl(entries: ReportEntry[]): string {
    return entries.map((e) => `${JSON.stringify(e)}\n`).join("");
}

const OUTCOMES: Outcome[] = ["kept", "rejected", "too-small", "duplicate", "parse-error", "crash"];

// Specifics like the operator or method name are part of the ranking key, so
// "unsupported-binary-op (%)" and "unsupported-binary-op (!==)" rank separately.
function reasonKey(e: ReportEntry): string {
    return e.detail === null ? `${e.reason}` : `${e.reason} (${e.detail})`;
}

function location(e: ReportEntry): string {
    return e.line === null ? e.path : `${e.path}:${e.line}`;
}

export function formatSummary(entries: ReportEntry[]): string {
    const lines = [`Report: ${entries.length} files`];

    for (const outcome of OUTCOMES) {
        const count = entries.filter((e) => e.outcome === outcome).length;
        lines.push(`  ${outcome.padEnd(12)}${String(count).padStart(6)}`);
    }

    const byReason = new Map<string, {count: number; example: ReportEntry}>();
    for (const e of entries) {
        if (e.outcome !== "rejected") continue;
        const key = reasonKey(e);
        const group = byReason.get(key);
        if (group === undefined) byReason.set(key, {count: 1, example: e});
        else group.count++;
    }

    if (byReason.size > 0) {
        const ranked = [...byReason].sort(([ka, a], [kb, b]) => b.count - a.count || ka.localeCompare(kb));
        const width = Math.max(...ranked.map(([key]) => key.length));
        lines.push("Rejection reasons (by count):");
        for (const [key, {count, example}] of ranked) {
            lines.push(`  ${String(count).padStart(6)}  ${key.padEnd(width)}  ${location(example)}`);
        }
    }

    const bugs = entries.filter((e) => e.outcome === "crash" || e.reason === "unrecorded");
    if (bugs.length > 0) {
        lines.push("Extractor bugs (crash / unrecorded):");
        for (const e of bugs) {
            lines.push(`  ${e.path}: ${e.outcome === "crash" ? e.message : "unrecorded rejection"}`);
        }
    }

    return `${lines.join("\n")}\n`;
}
