import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = await readFile(
	fileURLToPath(new URL("../extensions/multi-sub.ts", import.meta.url)),
	"utf8",
);

// Project-local input is explicit and fail-closed.
assert.match(source, /CONFIG_DIR_NAME/);
assert.match(source, /function loadProjectConfig\(cwd: string, projectTrusted: boolean\)/);
assert.match(source, /if \(projectTrusted !== true\) return undefined;/);
assert.match(source, /function loadEffectiveConfig\(cwd: string, projectTrusted: boolean\)/);
assert.match(source, /if \(!ctx\.isProjectTrusted\(\)\) \{\s*ctx\.ui\.notify\("multi-pass: project configuration is disabled until this project is trusted\./s);
assert.match(source, /function saveProjectConfig\(cwd: string, config: ProjectConfig, projectTrusted: boolean\)/);
assert.match(source, /Refusing to write project configuration before project trust is approved/);
for (const functionName of ["loadProjectConfig", "loadEffectiveConfig"]) {
	const oneArgumentCalls = [...source.matchAll(new RegExp(`\\b${functionName}\\(([^()\\n]*)\\)`, "g"))]
		.filter((match) => !match[1].includes(","));
	assert.deepEqual(oneArgumentCalls.map((match) => match[0]), [], `${functionName} must always receive explicit trust`);
}
for (const call of source.matchAll(/\bsaveProjectConfig\(([^\n]*)\)/g)) {
	assert.ok(call[1].split(",").length >= 3, `saveProjectConfig must receive explicit trust: ${call[0]}`);
}

// Project config is data-only; custom selectors come only from global config.
assert.match(source, /normalizePool\(pool, false\)/);
assert.match(source, /Project files are data-only overrides and may not activate global code/);
assert.match(source, /result\.strategy = "round-robin"/);

// Selector imports are constrained to the canonical global selectors directory.
assert.match(source, /resolve\(getAgentDir\(\), "selectors"\)/);
assert.match(source, /scriptPath\.split\(\/\[\\\\\/\]\+\/\)\.includes\("\.\."\)/);
assert.match(source, /realpathSync\(selectorRoot\)/);
assert.match(source, /realpathSync\(candidate\)/);
assert.match(source, /pathIsContained\(canonicalRoot, canonicalCandidate\)/);
assert.match(source, /statSync\(canonicalCandidate\)\.isFile\(\)/);
assert.match(source, /SELECTOR_EXTENSIONS = new Set\(\["\.js", "\.mjs", "\.cjs"\]\)/);
assert.match(source, /import\(pathToFileURL\(resolved\)\.href\)/);
assert.doesNotMatch(source, /if \(isAbsolute\(scriptPath\)\) return scriptPath/);
assert.doesNotMatch(source, /startsWith\("~\/"\)/);

// Writes are atomic, private, and do not follow symlink targets.
assert.match(source, /function saveJsonConfig\(path: string, config: unknown\): void/);
assert.match(source, /existingStat\.isSymbolicLink\(\)/);
assert.match(source, /lstatSync\(configDir\)\.isSymbolicLink\(\)/);
assert.match(source, /flag: "wx"/);
assert.match(source, /mode: 0o600/);
assert.match(source, /chmodSync\(temporaryPath, 0o600\)/);
assert.match(source, /copyFileSync\(path, backupPath, constants\.COPYFILE_EXCL\)/);
assert.match(source, /renameSync\(temporaryPath, path\)/);
assert.doesNotMatch(source, /writeFileSync\(projectPath, "\{\}"/);

// Failover uses a hidden fixed continuation and a narrow rate-limit classifier.
assert.match(source, /FAILOVER_CONTINUATION_PROMPT/);
assert.match(source, /FAILOVER_CONTINUATION_MARKER = "resume"/);
assert.match(source, /pi\.on\("agent_settled"/);
assert.match(source, /poolManager\.clearPendingContinuation\(\)/);
assert.match(source, /customType: FAILOVER_CONTINUATION_TYPE/);
assert.match(source, /content: FAILOVER_CONTINUATION_MARKER/);
assert.match(source, /display: false/);
assert.match(source, /\{ triggerTurn: true \}/);
assert.match(source, /pi\.on\("context"/);
assert.doesNotMatch(source, /sendUserMessage\(FAILOVER_CONTINUATION_PROMPT\)/);
assert.doesNotMatch(source, /sendUserMessage\(lastUserPrompt/);
assert.doesNotMatch(source, /function piWillRetryTurn/);
const matcherBlock = source.slice(source.indexOf("const RATE_LIMIT_PATTERNS"), source.indexOf("// Schedule evaluation helpers"));
assert.match(matcherBlock, /parseHttpStatus\(errorMessage\) === 429/);
assert.match(matcherBlock, /too many requests/);
assert.match(matcherBlock, /quota\[ _-\]\*\(\?:exceeded\|exhausted\)/);
assert.doesNotMatch(matcherBlock, /\/overloaded\/i|\/capacity\/i|\/429\/|\/quota\/i/);

// Deep normalization must guard malformed nested values and bound input sizes.
assert.match(source, /function isRecord\(value: unknown\)/);
assert.match(source, /MAX_CONFIG_ARRAY_LENGTH = 256/);
assert.match(source, /normalizeSubEntry/);
assert.match(source, /normalizeScheduleWindow/);
assert.match(source, /normalizePool\(raw: unknown, allowCustomSelector: boolean\)/);
assert.match(source, /entries\.length === 0/);
assert.doesNotMatch(source, /\.map\(boundedString\)/, "boundedString must not receive Array.map's index as its max argument");

console.log("hardening checks passed");
