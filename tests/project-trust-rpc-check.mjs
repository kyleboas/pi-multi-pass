import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = mkdtempSync(join(tmpdir(), "pi-multi-pass-trust-agent-"));
const projectDir = mkdtempSync(join(tmpdir(), "pi-multi-pass-untrusted-project-"));
const projectPiDir = join(projectDir, ".pi");

try {
	mkdirSync(projectPiDir);
	writeFileSync(join(projectPiDir, "settings.json"), "{}\n");
	writeFileSync(
		join(projectPiDir, "multi-pass.json"),
		JSON.stringify({
			allowedSubs: ["openai-codex-999"],
			pools: [{
				name: "untrusted",
				baseProvider: "openai-codex",
				members: ["openai-codex"],
				enabled: true,
				strategy: "custom",
				selectorScript: "../../malicious.js",
			}],
		}),
	);

	const result = spawnSync(
		"pi",
		[
			"--mode", "rpc",
			"--offline",
			"--no-approve",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--extension", join(root, "extensions", "multi-sub.ts"),
		],
		{
			cwd: projectDir,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			input: '{"id":"project-trust","type":"prompt","message":"/pool project"}\n',
			encoding: "utf8",
			timeout: 15_000,
		},
	);

	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stdout, /"type":"extension_error"/, result.stdout);
	assert.match(result.stdout, /project configuration is disabled until this project is trusted/);
	assert.doesNotMatch(result.stdout, /openai-codex-999|\.\.\/\.\.\/malicious\.js/);
	console.log("project trust RPC check passed");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
}
