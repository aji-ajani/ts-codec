import {Project, SourceFile, ts} from "ts-morph";
import * as fs from "fs";
import * as path from "path";
import {explainProgram, ProgramResult} from "./extract";
import {formatSummary, ReportEntry, snippetOf, toJsonl} from "./report";

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
        const entry = ({outcome, ...fields}: Partial<ReportEntry> & Pick<ReportEntry, "outcome">) =>
            entries.push({path: filePath, outcome, ...EMPTY_ENTRY, ...fields});

        let file: SourceFile | undefined;
        try {
            file = project.addSourceFileAtPath(filePath);

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
        } finally {
            file?.forget();
        }
    }

    return {corpus, entries};
}

// Every run writes corpus.json, report.jsonl and summary.txt into its own folder here,
// overwriting that folder's previous contents.
export const OUTPUT_ROOT = path.join(__dirname, "..", "experiments", "encoder-outputs");

const DEFAULT_INPUTS = ["experiments/corpora/sanity_corpus"];

// The output folder name for a set of inputs: their names joined with "+",
// e.g. "sanity_corpus+dsr_twins".
export function defaultName(inputs: string[]): string {
    return inputs.map((p) => path.basename(path.resolve(p), ".ts")).join("+");
}

// `argv` is process.argv.slice(2). Every positional argument is an input file or
// directory; `--name <name>` overrides the default, which is a folder name derived from the inputs.
export function parseArgs(argv: string[]): {inputs: string[]; name: string} {
    const inputs: string[] = [];
    let name: string | null = null;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--name") {
            if (i + 1 >= argv.length) throw new Error("--name requires a value");
            name = argv[++i];
        } else if (arg.startsWith("--")) {
            throw new Error(`unknown option ${arg}`);
        } else {
            inputs.push(arg);
        }
    }

    const resolvedInputs = inputs.length > 0 ? inputs : DEFAULT_INPUTS;
    const folderName = name ?? defaultName(resolvedInputs);
    if (folderName === "" || folderName === "." || folderName === ".." || /[\\/]/.test(folderName)) {
        throw new Error(`invalid output name "${folderName}": must be a single folder name`);
    }
    return {inputs: resolvedInputs, name: folderName};
}

function main() {
    const {inputs, name} = parseArgs(process.argv.slice(2));

    const {corpus, entries} = buildCorpus(inputs);
    const summary = formatSummary(entries);

    const outDir = path.join(OUTPUT_ROOT, name);
    fs.mkdirSync(outDir, {recursive: true});
    fs.writeFileSync(path.join(outDir, "corpus.json"), JSON.stringify(corpus, null, 4));
    fs.writeFileSync(path.join(outDir, "report.jsonl"), toJsonl(entries));
    fs.writeFileSync(path.join(outDir, "summary.txt"), summary);

    console.log(`Wrote ${corpus.length} programs and a report on ${entries.length} files to ${path.relative(process.cwd(), outDir)}`);
    // ? Uncommenting this prints a line to the console for each corpus entry
    // for (const entry of corpus) console.log(`  ${entry}`);
    process.stdout.write(summary);
}

if (require.main === module) main();
