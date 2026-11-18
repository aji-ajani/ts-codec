import {Project, SourceFile, ts} from "ts-morph";
import * as fs from "fs";
import * as path from "path";
import {explainProgram, ProgramResult} from "./extract";
import {ReportEntry, snippetOf} from "./report";

// Rough AST-size proxy: every operator and every leaf is one whitespace/paren-
// delimited token, so counting tokens approximates counting term nodes
// without needing a separate s-expression parser on the TS side.
export function astSize(sexpr: string): number {
    const tokens = sexpr.match(/[^\s()]+/g);
    return tokens === null ? 0 : tokens.length;
}

function collectTsFiles(inputPath: string): string[] {
    if (fs.statSync(inputPath).isDirectory()) {
        return fs.readdirSync(inputPath)
            .filter((name) => name.endsWith(".ts"))
            .map((name) => path.join(inputPath, name));
    }
    return [inputPath];
}

const EMPTY_ENTRY: Omit<ReportEntry, "path" | "outcome"> = {
    reason: null, detail: null, line: null, snippet: null, termSize: null, duplicateOf: null, message: null,
};

// Builds the corpus and, in the same pass, one outcome per input file.
// In real use cases, `explain` will use its default, while tests use it to
// manufacture a crash.
export function buildCorpus(
    inputPaths: string[],
    minAstSize = 3,
    explain: (f: SourceFile) => ProgramResult = explainProgram,
): {corpus: string[]; entries: ReportEntry[]} {
    const project = new Project();
    const firstProducer = new Map<string, string>(); // term → path of the file that first produced it
    const corpus: string[] = [];
    const entries: ReportEntry[] = [];

    for (const filePath of inputPaths.flatMap(collectTsFiles)) {
        const entry = (fields: Partial<ReportEntry> & Pick<ReportEntry, "outcome">) =>
            entries.push({path: filePath, ...EMPTY_ENTRY, ...fields});

        try {
            const file = project.addSourceFileAtPath(filePath);

            const diagnostics = project.getProgram().getSyntacticDiagnostics(file);
            if (diagnostics.length > 0) {
                const first = diagnostics[0];
                entry({
                    outcome: "parse-error",
                    line: first.getLineNumber() ?? null,
                    message: ts.flattenDiagnosticMessageText(first.compilerObject.messageText, "\n"),
                });
                continue;
            }

            const {term, rejection} = explain(file);
            if (term === null) {
                entry({
                    outcome: "rejected",
                    reason: rejection?.reason ?? "unrecorded",
                    detail: rejection?.detail ?? null,
                    line: rejection?.node.getStartLineNumber() ?? null,
                    snippet: rejection ? snippetOf(rejection.node) : null,
                });
                continue;
            }

            const termSize = astSize(term);
            if (termSize < minAstSize) {
                entry({outcome: "too-small", termSize});
                continue;
            }

            const original = firstProducer.get(term);
            if (original !== undefined) {
                entry({outcome: "duplicate", termSize, duplicateOf: original});
                continue;
            }

            firstProducer.set(term, filePath);
            corpus.push(term);
            entry({outcome: "kept", termSize});
        } catch (e) {
            entry({outcome: "crash", message: e instanceof Error ? e.message : String(e)});
        }
    }

    return {corpus, entries};
}

function main() {
    const inputs = process.argv.length > 2 ? process.argv.slice(2, -1) : ["experiments/sanity_corpus"];
    const outputPath = process.argv.length > 3 ? process.argv[process.argv.length - 1] : "experiments/data/ts-corpus.json";

    const {corpus} = buildCorpus(inputs);

    fs.mkdirSync(path.dirname(outputPath), {recursive: true});
    fs.writeFileSync(outputPath, JSON.stringify(corpus, null, 4));

    console.log(`Wrote ${corpus.length} programs to ${outputPath}`);
    for (const entry of corpus) console.log(`  ${entry}`);
}

if (require.main === module) main();
