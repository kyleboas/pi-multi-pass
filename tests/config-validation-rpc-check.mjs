import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = mkdtempSync(join(tmpdir(), "pi-multi-pass-config-agent-"));
const projectDir = mkdtempSync(join(tmpdir(), "pi-multi-pass-config-project-"));

try {
	writeFileSync(
		join(agentDir, "multi-pass.json"),
		JSON.stringify({
			subscriptions: [null, 7, {}, { provider: 42, index: "two" }, { provider: "openai-codex", index: 2 }],
			pools: [null, { members: 9 }, {
				name: "valid",
				baseProvider: "openai-codex",
				members: [null, "wrong-provider-2", "openai-codex", "openai-codex-2"],
				enabled: true,
			}],
			chains: [null, { name: "empty", entries: [] }, { name: "bad", entries: [null, 4] }],
			presets: [null, { name: "empty", entries: [] }, { name: "bad", entries: [{ provider: 4, model: null }] }],
		}),
	);
	const projectPiDir = join(projectDir, ".pi");
	mkdirSync(projectPiDir);
	writeFileSync(join(projectPiDir, "settings.json"), "{}\n");
	writeFileSync(
		join(projectPiDir, "multi-pass.json"),
		JSON.stringify({
			allowedSubs: [null, 3, {}, "unknown-provider", "openai-codex-2"],
			pools: [null, {
				name: "project",
				baseProvider: "openai-codex",
				members: [null, "openai-codex-2"],
				strategy: "custom",
				selectorScript: "../../malicious.js",
			}],
			chains: [null, { name: "empty", entries: [null] }],
		}),
	);

	const result = spawnSync(
		"pi",
		[
			"--mode", "rpc", "--offline", "--approve",
			"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
			"--extension", join(root, "extensions", "multi-sub.ts"),
		],
		{
			cwd: projectDir,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			input: '{"id":"config-validation","type":"prompt","message":"/subs status"}\n',
			encoding: "utf8",
			timeout: 15_000,
		},
	);

	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stdout, /"type":"extension_error"/, result.stdout);
	assert.match(result.stdout, /"id":"config-validation","type":"response","command":"prompt","success":true/);
	assert.doesNotMatch(result.stdout, /malicious\.js|unknown-provider/);
	console.log("config validation RPC check passed");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
}
