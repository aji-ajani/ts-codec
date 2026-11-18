import test from "node:test"
import assert from "node:assert/strict"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {astSize, buildCorpus} from "../src/corpus"
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
