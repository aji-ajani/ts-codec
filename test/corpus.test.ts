import test from "node:test"
import assert from "node:assert/strict"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {astSize, buildCorpus, parseArgs} from "../src/corpus"
import {formatSummary, ReportEntry, toJsonl} from "../src/report"
import {explainProgram} from "../src/extract"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-codec-"));
const fixtures: Record<string, string> = {
    "kept.ts": "const f = (a: number, b: number) => a - b;",
    "dup.ts": "const f = (a: number, b: number) => a - b;",
    "small.ts": "// nothing to encode\n", // encodes as `pass`: 1 token, below the default minimum of 3
    "bad.ts": "var x = 1;",
    "broken.ts": "const x = ;",
};
for (const [name, src] of Object.entries(fixtures)) fs.writeFileSync(path.join(dir, name), src);
const at = (name: string) => path.join(dir, name);
const ordered = ["kept.ts", "dup.ts", "small.ts", "bad.ts", "broken.ts"].map(at);

test("buildCorpus classifies every file", () => {
    const {corpus, entries} = buildCorpus(ordered);
    const by = Object.fromEntries(entries.map((e) => [path.basename(e.path), e]));

    assert.equal(corpus.length, 1);
    assert.equal(entries.length, 5);

    assert.equal(by["kept.ts"].outcome, "kept");
    assert.equal(by["kept.ts"].termSize, astSize(corpus[0]));

    assert.equal(by["dup.ts"].outcome, "duplicate");
    assert.equal(by["dup.ts"].duplicateOf, at("kept.ts"));

    assert.equal(by["small.ts"].outcome, "too-small");
    assert.equal(by["small.ts"].termSize, 1);

    assert.deepEqual([by["bad.ts"].outcome, by["bad.ts"].reason, by["bad.ts"].line], ["rejected", "var-decl", 1]);
    assert.equal(by["bad.ts"].snippet, "var x = 1;");

    assert.equal(by["broken.ts"].outcome, "parse-error");
    assert.equal(by["broken.ts"].line, 1);
    assert.notEqual(by["broken.ts"].message, null);
});

test("entries keep every key, null when not applicable", () => {
    const {entries} = buildCorpus([at("kept.ts")]);
    assert.deepEqual(Object.keys(entries[0]).sort(),
        ["detail", "duplicateOf", "line", "message", "outcome", "path", "reason", "snippet", "termSize"]);
    assert.equal(entries[0].reason, null);
});

test("a crashing file is reported and the run continues", () => {
    const {corpus, entries} = buildCorpus([at("kept.ts"), at("dup.ts")], 3, (f) => {
        if (f.getBaseName() === "kept.ts") throw new Error("boom");
        return explainProgram(f);
    });
    assert.deepEqual(entries.map((e) => [path.basename(e.path), e.outcome]), [["kept.ts", "crash"], ["dup.ts", "kept"]]);
    assert.equal(entries[0].message, "boom");
    assert.equal(corpus.length, 1);
});

test("a null term with no recorded rejection is reported as unrecorded", () => {
    const {entries} = buildCorpus([at("kept.ts")], 3, () => ({term: null, rejection: null}));
    assert.equal(entries[0].outcome, "rejected");
    assert.equal(entries[0].reason, "unrecorded");
});

test("parseArgs: positional semantics unchanged", () => {
    assert.deepEqual(parseArgs([]), {inputs: ["experiments/sanity_corpus"], outputPath: "experiments/data/ts-corpus.json", reportPath: null});
    assert.deepEqual(parseArgs(["a", "b", "out.json"]), {inputs: ["a", "b"], outputPath: "out.json", reportPath: null});
});

test("parseArgs: --report is extracted from any position", () => {
    assert.deepEqual(parseArgs(["--report", "r.jsonl", "a", "out.json"]), {inputs: ["a"], outputPath: "out.json", reportPath: "r.jsonl"});
    assert.equal(parseArgs(["a", "out.json", "--report", "r.jsonl"]).reportPath, "r.jsonl");
});

test("parseArgs: --report without a value throws", () => {
    assert.throws(() => parseArgs(["a", "out.json", "--report"]), /--report requires a path/);
});

const row = (fields: Partial<ReportEntry> & Pick<ReportEntry, "path" | "outcome">): ReportEntry => ({
    reason: null, detail: null, line: null, snippet: null, termSize: null, duplicateOf: null, message: null, ...fields,
});

test("toJsonl: one parseable object per line with every key", () => {
    const text = toJsonl([row({path: "a.ts", outcome: "kept", termSize: 5}), row({path: "b.ts", outcome: "crash", message: "boom"})]);
    assert.ok(text.endsWith("\n"));
    const lines = text.trimEnd().split("\n");
    assert.equal(lines.length, 2);
    for (const line of lines) assert.equal(Object.keys(JSON.parse(line)).length, 9);
    assert.equal(JSON.parse(lines[1]).message, "boom");
});

test("formatSummary: counts, ranking, example location", () => {
    const summary = formatSummary([
        row({path: "a.ts", outcome: "rejected", reason: "unsupported-binary-op", detail: "%", line: 2}),
        row({path: "b.ts", outcome: "rejected", reason: "unsupported-binary-op", detail: "%", line: 7}),
        row({path: "c.ts", outcome: "rejected", reason: "unsupported-binary-op", detail: "%", line: 1}),
        row({path: "d.ts", outcome: "rejected", reason: "var-decl", line: 1}),
        row({path: "e.ts", outcome: "kept", termSize: 5}),
        row({path: "f.ts", outcome: "crash", message: "boom"}),
    ]);
    assert.match(summary, /^Report: 6 files$/m);
    assert.match(summary, /^\s+kept\s+1$/m);
    assert.match(summary, /^\s+rejected\s+4$/m);
    assert.match(summary, /^\s+too-small\s+0$/m);
    assert.match(summary, /^\s+crash\s+1$/m);

    const reasonRows = summary.split("\n").filter((l) => /^\s+\d+\s+\S+.*\.ts:\d+$/.test(l));
    assert.match(reasonRows[0], /^\s+3\s+unsupported-binary-op \(%\)\s+a\.ts:2$/);
    assert.match(reasonRows[1], /^\s+1\s+var-decl\s+d\.ts:1$/);

    assert.match(summary, /^Extractor bugs \(crash \/ unrecorded\):$/m);
    assert.match(summary, /^\s+f\.ts: boom$/m);
});

test("formatSummary: no bugs heading when there are no crashes or unrecorded rejections", () => {
    assert.doesNotMatch(formatSummary([row({path: "e.ts", outcome: "kept", termSize: 5})]), /Extractor bugs/);
});

test("formatSummary: an unrecorded rejection is ranked and listed as a bug", () => {
    const summary = formatSummary([row({path: "u.ts", outcome: "rejected", reason: "unrecorded"})]);
    assert.match(summary, /^\s+1\s+unrecorded\s+u\.ts$/m);
    assert.match(summary, /^\s+u\.ts: unrecorded rejection$/m);
});
