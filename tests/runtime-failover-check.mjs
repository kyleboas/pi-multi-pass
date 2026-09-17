import assert from "node:assert/strict";

function getChainEntryIssue(entry, config, modelRegistry) {
  const pool = config.pools.find((candidate) => candidate.name === entry.pool);
  if (!pool) return `invalid pool: ${entry.pool} missing`;
  if (!pool.enabled) return `invalid pool: ${pool.name} disabled`;
  const selectableModels = [...(modelRegistry.get(pool.baseProvider) || [])];
  if (selectableModels.length === 0) {
    return `invalid model: no selectable models for ${pool.baseProvider}`;
  }
  if (!selectableModels.includes(entry.model)) {
    return `invalid model: ${entry.model} unavailable for ${pool.name}`;
  }
  return null;
}

function classifyPoolMemberSkip(poolName, provider, authStorage, exhausted) {
  if (!authStorage.hasAuth(provider)) {
    return {
      type: "pool-member",
      poolName,
      reason: "no-auth",
      detail: `${provider} skipped (no auth)`,
    };
  }
  if (exhausted) {
    return {
      type: "pool-member",
      poolName,
      reason: "exhausted",
      detail: `${provider} skipped (cooldown active)`,
    };
  }
  return null;
}

function classifyChainEntrySkip(chain, chainIndex, entry, config) {
  if (!entry.enabled) {
    return {
      type: "chain-entry",
      poolName: entry.pool,
      reason: "disabled-entry",
      detail: `${entry.pool} -> ${entry.model} skipped (entry disabled)`,
      chainName: chain.name,
      chainIndex,
    };
  }
  const issue = getChainEntryIssue(entry, config, createModelCatalog());
  if (!issue) return null;
  const reason = issue.includes("missing")
    ? "missing-pool"
    : issue.includes("disabled")
      ? "disabled-pool"
      : "unavailable-model";
  return {
    type: "chain-entry",
    poolName: entry.pool,
    reason,
    detail: `${entry.pool} -> ${entry.model} skipped (${issue})`,
    chainName: chain.name,
    chainIndex,
  };
}

function formatFailoverTarget(candidate) {
  return `${candidate.provider} (${candidate.modelId})`;
}

function formatFailoverStatus(candidate, fallbackPoolName) {
  if (!candidate) {
    return fallbackPoolName
      ? `pool:${fallbackPoolName} | cascade exhausted | no eligible target`
      : "cascade exhausted | no eligible target";
  }
  const scope = candidate.source === "chain"
    ? `chain:${candidate.chainName}#${(candidate.chainIndex ?? 0) + 1}`
    : `pool:${candidate.poolName}`;
  return `${scope} | active ${formatFailoverTarget(candidate)}`;
}

function formatFailoverExhausted(poolName, currentProvider) {
  return `[pool:${poolName}] Failover exhausted after ${currentProvider}; no eligible target remained in this cascade.`;
}

const RATE_LIMIT_PATTERNS = [
  /\busage[ _-]*limit(?:[ _-]*(?:reached|exceeded|exhausted))?\b/i,
  /\brate[ _-]*limit(?:ed|ing)?\b/i,
  /\btoo many requests\b/i,
  /\bquota[ _-]*(?:exceeded|exhausted)\b/i,
  /\bresource[ _-]*exhausted\b/i,
];
const FAILOVER_CONTINUATION_TYPE = "multi-pass";
const FAILOVER_CONTINUATION_MARKER = "resume";
const FAILOVER_CONTINUATION_PROMPT =
  "Continue the interrupted request from the existing conversation context. Do not repeat tool calls or side effects that already completed.";

function parseHttpStatus(errorMessage) {
  const leading = errorMessage.match(/^\s*(?:Error:\s*)?(\d{3})\b/);
  if (leading) return Number(leading[1]);
  const http = errorMessage.match(/^\s*(?:Error:\s*)?HTTP\s+(\d{3})\b/i);
  if (http) return Number(http[1]);
  const field = errorMessage.match(/"status"\s*:\s*(\d{3})\b/);
  return field ? Number(field[1]) : undefined;
}

function isRateLimitError(errorMessage) {
  return parseHttpStatus(errorMessage) === 429 || RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

class RuntimeHarness {
  constructor(config, authenticatedProviders) {
    this.config = config;
    this.providerToPool = new Map();
    this.exhausted = new Set();
    this.authStorage = createAuthStorage(authenticatedProviders);
    this.modelCatalog = createModelCatalog();
    this.notifications = [];
    this.statuses = [];
    this.sentMessages = [];
    this.sentMessageOptions = [];
    this.setModelCalls = [];
    this.cascadeState = null;
    this.safeContinuationPending = false;

    for (const pool of config.pools) {
      if (!pool.enabled) continue;
      for (const member of pool.members) this.providerToPool.set(member, pool.name);
    }
  }

  getPoolForProvider(provider) {
    const poolName = this.providerToPool.get(provider);
    return this.config.pools.find((pool) => pool.name === poolName);
  }

  isMemberExhausted(pool, provider) {
    return this.exhausted.has(`${pool.name}:${provider}`);
  }

  markExhausted(provider) {
    const pool = this.getPoolForProvider(provider);
    if (!pool) return;
    this.exhausted.add(`${pool.name}:${provider}`);
  }

  findApplicableChain(poolName) {
    for (const chain of this.config.chains.filter((candidate) => candidate.enabled)) {
      const index = chain.entries.findIndex((entry) => entry.pool === poolName);
      if (index >= 0) return { chain, index };
    }
    return undefined;
  }

  startTurn(prompt, currentModel) {
    if (!prompt) {
      this.cascadeState = null;
      return;
    }
    if (!this.cascadeState || this.cascadeState.prompt !== prompt) {
      this.cascadeState = {
        prompt,
        attemptedProviders: new Set(currentModel ? [currentModel.provider] : []),
        visitedChainIndexes: new Set(),
      };
      return;
    }
    if (currentModel) {
      this.cascadeState.attemptedProviders.add(currentModel.provider);
    }
  }

  ensureCascadeState(prompt, currentModel) {
    if (!prompt) {
      this.cascadeState = {
        prompt: "",
        attemptedProviders: new Set([currentModel.provider]),
        visitedChainIndexes: new Set(),
      };
      return this.cascadeState;
    }
    if (!this.cascadeState || this.cascadeState.prompt !== prompt) {
      this.cascadeState = {
        prompt,
        attemptedProviders: new Set([currentModel.provider]),
        visitedChainIndexes: new Set(),
      };
    } else {
      this.cascadeState.attemptedProviders.add(currentModel.provider);
    }
    return this.cascadeState;
  }

  buildFailoverPlan(currentModel) {
    const attemptedProviders = this.cascadeState?.attemptedProviders || new Set();
    const visitedChainIndexes = this.cascadeState?.visitedChainIndexes || new Set();
    const pool = this.getPoolForProvider(currentModel.provider);
    if (!pool) return { candidates: [], skips: [] };

    const skips = [];
    const candidates = [];
    const currentIndex = pool.members.indexOf(currentModel.provider);
    const startIndex = currentIndex >= 0 ? currentIndex : 0;

    for (let step = 1; step <= pool.members.length; step += 1) {
      const candidateIndex = (startIndex + step) % pool.members.length;
      const candidate = pool.members[candidateIndex];
      if (candidate === currentModel.provider) continue;
      if (attemptedProviders.has(candidate)) {
        skips.push({
          type: "pool-member",
          poolName: pool.name,
          reason: "already-attempted",
          detail: `${candidate} skipped (already attempted this turn)`,
        });
        continue;
      }
      const skip = classifyPoolMemberSkip(
        pool.name,
        candidate,
        this.authStorage,
        this.isMemberExhausted(pool, candidate),
      );
      if (skip) {
        skips.push(skip);
        continue;
      }
      candidates.push({
        poolName: pool.name,
        provider: candidate,
        modelId: currentModel.id,
        source: "pool",
      });
    }

    const applicable = this.findApplicableChain(pool.name);
    if (!applicable) return { pool, candidates, skips };

    for (let chainIndex = applicable.index + 1; chainIndex < applicable.chain.entries.length; chainIndex += 1) {
      const entry = applicable.chain.entries[chainIndex];
      if (visitedChainIndexes.has(chainIndex)) {
        skips.push({
          type: "chain-entry",
          poolName: entry.pool,
          reason: "already-visited-chain-entry",
          detail: `${entry.pool} -> ${entry.model} skipped (chain entry already visited this turn)`,
          chainName: applicable.chain.name,
          chainIndex,
        });
        continue;
      }
      const entrySkip = classifyChainEntrySkip(applicable.chain, chainIndex, entry, this.config);
      if (entrySkip) {
        skips.push(entrySkip);
        continue;
      }
      const targetPool = this.config.pools.find((candidate) => candidate.name === entry.pool);
      if (!targetPool) continue;

      let foundEligible = false;
      for (const member of targetPool.members) {
        if (attemptedProviders.has(member)) {
          skips.push({
            type: "pool-member",
            poolName: targetPool.name,
            reason: "already-attempted",
            detail: `${member} skipped (already attempted this turn)`,
            chainName: applicable.chain.name,
            chainIndex,
          });
          continue;
        }
        const memberSkip = classifyPoolMemberSkip(
          targetPool.name,
          member,
          this.authStorage,
          this.isMemberExhausted(targetPool, member),
        );
        if (memberSkip) {
          skips.push({ ...memberSkip, chainName: applicable.chain.name, chainIndex });
          continue;
        }
        foundEligible = true;
        candidates.push({
          poolName: targetPool.name,
          provider: member,
          modelId: entry.model,
          source: "chain",
          chainName: applicable.chain.name,
          chainIndex,
        });
      }
      if (!foundEligible) {
        skips.push({
          type: "chain-entry",
          poolName: targetPool.name,
          reason: "no-eligible-members",
          detail: `${targetPool.name} -> ${entry.model} skipped (no eligible members)`,
          chainName: applicable.chain.name,
          chainIndex,
        });
      }
    }

    return {
      pool,
      chain: applicable.chain,
      currentChainIndex: applicable.index,
      candidates,
      skips,
    };
  }

  findModel(provider, modelId) {
    const baseProvider = provider.replace(/-\d+$/, "");
    const models = this.modelCatalog.get(baseProvider) || [];
    return models.includes(modelId) ? { provider, id: modelId } : undefined;
  }

  async setModel(model) {
    this.setModelCalls.push(`${model.provider}:${model.id}`);
    this.currentModel = model;
    return this.authStorage.hasAuth(model.provider);
  }

  notify(message, level) {
    this.notifications.push({ message, level });
  }

  setStatus(_key, value) {
    this.statuses.push(value);
  }

  sendMessage(message, options) {
    this.sentMessages.push(message);
    this.sentMessageOptions.push(options);
  }

  expandContinuationContext(messages) {
    return messages.map((message) =>
      message.role === "custom" &&
      message.customType === FAILOVER_CONTINUATION_TYPE &&
      message.content === FAILOVER_CONTINUATION_MARKER
        ? { ...message, content: FAILOVER_CONTINUATION_PROMPT }
        : message,
    );
  }

  async handleError(errorMessage, currentModel, prompt) {
    this.safeContinuationPending = false;
    if (!currentModel) return false;
    if (!isRateLimitError(errorMessage)) return false;

    const pool = this.getPoolForProvider(currentModel.provider);
    if (!pool) return false;

    const cascade = this.ensureCascadeState(prompt, currentModel);
    this.markExhausted(currentModel.provider);
    const plan = this.buildFailoverPlan(currentModel);

    const nextCandidate = plan.candidates[0];
    if (!nextCandidate) {
      this.notify(formatFailoverExhausted(pool.name, currentModel.provider), "warning");
      this.setStatus("multi-pass", formatFailoverStatus(null, pool.name));
      return false;
    }

    const nextModel = this.findModel(nextCandidate.provider, nextCandidate.modelId);
    if (!nextModel) {
      this.notify(formatFailoverExhausted(pool.name, currentModel.provider), "warning");
      this.setStatus("multi-pass", formatFailoverStatus(null, pool.name));
      return false;
    }

    const success = await this.setModel(nextModel);
    if (!success) {
      this.notify(formatFailoverExhausted(pool.name, currentModel.provider), "warning");
      this.setStatus("multi-pass", formatFailoverStatus(null, pool.name));
      return false;
    }

    cascade.attemptedProviders.add(nextCandidate.provider);
    if (typeof nextCandidate.chainIndex === "number") {
      cascade.visitedChainIndexes.add(nextCandidate.chainIndex);
    }

    this.setStatus("multi-pass", formatFailoverStatus(nextCandidate));
    if (prompt) this.safeContinuationPending = true;
    return true;
  }

  finishSuccessfulTurn() {
    this.safeContinuationPending = false;
  }

  settle() {
    if (!this.safeContinuationPending) return;
    this.safeContinuationPending = false;
    this.sendMessage(
      {
        role: "custom",
        customType: FAILOVER_CONTINUATION_TYPE,
        content: FAILOVER_CONTINUATION_MARKER,
        display: false,
      },
      { triggerTurn: true },
    );
  }

  snapshot() {
    return {
      attemptedProviders: [...(this.cascadeState?.attemptedProviders || [])],
      visitedChainIndexes: [...(this.cascadeState?.visitedChainIndexes || [])],
      setModelCalls: [...this.setModelCalls],
      sentMessages: [...this.sentMessages],
      sentMessageOptions: [...this.sentMessageOptions],
      safeContinuationPending: this.safeContinuationPending,
      notifications: [...this.notifications],
      statuses: [...this.statuses],
    };
  }
}

function createAuthStorage(authenticatedProviders) {
  const authed = new Set(authenticatedProviders);
  return {
    hasAuth(provider) {
      return authed.has(provider);
    },
  };
}

function createModelCatalog() {
  return new Map([
    ["anthropic", ["claude-sonnet-4", "claude-opus-4.1"]],
    ["openai-codex", ["gpt-5", "gpt-5-mini"]],
    ["google-gemini-cli", ["gemini-2.5-pro"]],
    ["google-antigravity", []],
  ]);
}

function createConfig() {
  return {
    pools: [
      {
        name: "primary",
        baseProvider: "anthropic",
        members: ["anthropic", "anthropic-2", "anthropic-3"],
        enabled: true,
      },
      {
        name: "backup",
        baseProvider: "openai-codex",
        members: ["openai-codex", "openai-codex-2"],
        enabled: true,
      },
      {
        name: "solo",
        baseProvider: "google-gemini-cli",
        members: ["google-gemini-cli"],
        enabled: true,
      },
      {
        name: "disabled-pool",
        baseProvider: "anthropic",
        members: ["anthropic-9"],
        enabled: false,
      },
    ],
    chains: [
      {
        name: "ordered-fallback",
        enabled: true,
        entries: [
          { pool: "primary", model: "claude-sonnet-4", enabled: true },
          { pool: "backup", model: "gpt-5-mini", enabled: true },
          { pool: "solo", model: "gemini-2.5-pro", enabled: true },
        ],
      },
    ],
  };
}

function runCoreChecks() {
  const config = createConfig();
  const harness = new RuntimeHarness(config, [
    "anthropic",
    "anthropic-2",
    "anthropic-3",
    "openai-codex",
    "openai-codex-2",
    "google-gemini-cli",
  ]);

  harness.startTurn("draft release notes", { provider: "anthropic", id: "claude-sonnet-4" });
  harness.markExhausted("anthropic");
  const plan = harness.buildFailoverPlan({ provider: "anthropic", id: "claude-sonnet-4" });

  assert.equal(plan.pool.name, "primary");
  assert.equal(plan.chain.name, "ordered-fallback");
  assert.equal(plan.currentChainIndex, 0);
  assert.deepEqual(
    plan.candidates.map((candidate) => `${candidate.source}:${candidate.poolName}:${candidate.provider}:${candidate.modelId}`),
    [
      "pool:primary:anthropic-2:claude-sonnet-4",
      "pool:primary:anthropic-3:claude-sonnet-4",
      "chain:backup:openai-codex:gpt-5-mini",
      "chain:backup:openai-codex-2:gpt-5-mini",
      "chain:solo:google-gemini-cli:gemini-2.5-pro",
    ],
  );
}

async function runPoolOnlyChecks() {
  const config = createConfig();
  config.chains = [];
  const harness = new RuntimeHarness(config, ["anthropic", "anthropic-2", "anthropic-3"]);
  const prompt = "summarize incident";

  harness.startTurn(prompt, { provider: "anthropic", id: "claude-sonnet-4" });
  const rotated = await harness.handleError("429 rate limit", { provider: "anthropic", id: "claude-sonnet-4" }, prompt);
  assert.equal(rotated, true);

  const snapshot = harness.snapshot();
  assert.deepEqual(snapshot.setModelCalls, ["anthropic-2:claude-sonnet-4"]);
  assert.deepEqual(snapshot.sentMessages, []);
  assert.equal(snapshot.statuses.at(-1), "pool:primary | active anthropic-2 (claude-sonnet-4)");
  assert.deepEqual(snapshot.notifications, []);
  assert.equal(snapshot.attemptedProviders.includes("anthropic"), true);
  assert.equal(snapshot.attemptedProviders.includes("anthropic-2"), true);
  assert.equal(snapshot.visitedChainIndexes.length, 0);

  console.log("pool-only checks passed");
}

async function runNoLoopChecks() {
  const config = createConfig();
  const harness = new RuntimeHarness(config, [
    "anthropic",
    "anthropic-2",
    "anthropic-3",
    "openai-codex",
    "openai-codex-2",
    "google-gemini-cli",
  ]);
  const prompt = "write migration guide";

  harness.startTurn(prompt, { provider: "anthropic", id: "claude-sonnet-4" });
  const first = await harness.handleError("429 rate limit", { provider: "anthropic", id: "claude-sonnet-4" }, prompt);
  assert.equal(first, true);

  harness.startTurn(prompt, { provider: "anthropic-2", id: "claude-sonnet-4" });
  const second = await harness.handleError("429 rate limit", { provider: "anthropic-2", id: "claude-sonnet-4" }, prompt);
  assert.equal(second, true);

  harness.startTurn(prompt, { provider: "anthropic-3", id: "claude-sonnet-4" });
  const third = await harness.handleError("429 rate limit", { provider: "anthropic-3", id: "claude-sonnet-4" }, prompt);
  assert.equal(third, true);

  harness.startTurn(prompt, { provider: "openai-codex", id: "gpt-5-mini" });
  const fourth = await harness.handleError("429 rate limit", { provider: "openai-codex", id: "gpt-5-mini" }, prompt);
  assert.equal(fourth, true);

  harness.startTurn(prompt, { provider: "openai-codex-2", id: "gpt-5-mini" });
  const fifth = await harness.handleError("429 rate limit", { provider: "openai-codex-2", id: "gpt-5-mini" }, prompt);
  assert.equal(fifth, true);

  harness.startTurn(prompt, { provider: "google-gemini-cli", id: "gemini-2.5-pro" });
  const exhausted = await harness.handleError("429 rate limit", { provider: "google-gemini-cli", id: "gemini-2.5-pro" }, prompt);
  assert.equal(exhausted, false);

  const snapshot = harness.snapshot();
  assert.deepEqual(snapshot.setModelCalls, [
    "anthropic-2:claude-sonnet-4",
    "anthropic-3:claude-sonnet-4",
    "openai-codex:gpt-5-mini",
    "openai-codex-2:gpt-5-mini",
    "google-gemini-cli:gemini-2.5-pro",
  ]);
  assert.deepEqual(snapshot.visitedChainIndexes, [1, 2]);
  assert.deepEqual(snapshot.sentMessages, []);
  assert.equal(snapshot.statuses.at(-2), "chain:ordered-fallback#3 | active google-gemini-cli (gemini-2.5-pro)");
  assert.equal(snapshot.statuses.at(-1), "pool:solo | cascade exhausted | no eligible target");
  assert.deepEqual(snapshot.notifications, [
    {
      message: "[pool:solo] Failover exhausted after google-gemini-cli; no eligible target remained in this cascade.",
      level: "warning",
    },
  ]);

  console.log("no-loop checks passed");
}

async function runFailurePathChecks() {
  const config = createConfig();
  config.chains[0].entries = [
    { pool: "primary", model: "claude-sonnet-4", enabled: true },
    { pool: "disabled-pool", model: "claude-sonnet-4", enabled: true },
    { pool: "missing-pool", model: "claude-sonnet-4", enabled: true },
    { pool: "backup", model: "claude-ghost", enabled: false },
    { pool: "solo", model: "gemini-2.5-pro", enabled: true },
  ];
  const runtimeHarness = new RuntimeHarness(config, ["anthropic", "google-gemini-cli"]);

  runtimeHarness.startTurn("debug retries", { provider: "anthropic", id: "claude-sonnet-4" });
  runtimeHarness.markExhausted("google-gemini-cli");
  const rotated = await runtimeHarness.handleError("429 rate limit", { provider: "anthropic", id: "claude-sonnet-4" }, "debug retries");
  assert.equal(rotated, false);

  const snapshot = runtimeHarness.snapshot();
  const warningMessages = snapshot.notifications
    .filter((entry) => entry.level === "warning")
    .map((entry) => entry.message);

  assert.deepEqual(
    warningMessages,
    ["[pool:primary] Failover exhausted after anthropic; no eligible target remained in this cascade."],
  );
  assert.deepEqual(snapshot.statuses.at(-1), "pool:primary | cascade exhausted | no eligible target");
  assert.deepEqual(snapshot.setModelCalls, []);
  assert.deepEqual(snapshot.sentMessages, []);

  const plannerHarness = new RuntimeHarness(config, ["anthropic", "google-gemini-cli"]);
  plannerHarness.startTurn("debug retries", { provider: "anthropic", id: "claude-sonnet-4" });
  plannerHarness.markExhausted("anthropic");
  plannerHarness.markExhausted("google-gemini-cli");
  const plan = plannerHarness.buildFailoverPlan({ provider: "anthropic", id: "claude-sonnet-4" });
  assert.deepEqual(
    plan.skips.map((skip) => `${skip.reason}:${skip.detail}`),
    [
      "no-auth:anthropic-2 skipped (no auth)",
      "no-auth:anthropic-3 skipped (no auth)",
      "disabled-pool:disabled-pool -> claude-sonnet-4 skipped (invalid pool: disabled-pool disabled)",
      "missing-pool:missing-pool -> claude-sonnet-4 skipped (invalid pool: missing-pool missing)",
      "disabled-entry:backup -> claude-ghost skipped (entry disabled)",
      "exhausted:google-gemini-cli skipped (cooldown active)",
      "no-eligible-members:solo -> gemini-2.5-pro skipped (no eligible members)",
    ],
  );
  assert.deepEqual(plan.candidates, []);

  console.log("failure-path checks passed");
}

function renderSessionStatus(config) {
  const enabledChains = config.chains.filter((chain) => chain.enabled);
  const activeChain = enabledChains[0];
  if (activeChain) {
    const firstEnabledEntry = activeChain.entries.find((entry) => entry.enabled);
    if (firstEnabledEntry) {
      return `chain:${activeChain.name} | starts ${firstEnabledEntry.pool} -> ${firstEnabledEntry.model}`;
    }
  }

  return null;
}

function runSessionStatusChecks() {
  const config = createConfig();
  assert.equal(
    renderSessionStatus(config),
    "chain:ordered-fallback | starts primary -> claude-sonnet-4",
  );

  config.chains[0].enabled = false;
  assert.equal(renderSessionStatus(config), null);

  config.chains[0].enabled = true;
  config.chains[0].entries[0].enabled = false;
  assert.equal(
    renderSessionStatus(config),
    "chain:ordered-fallback | starts backup -> gpt-5-mini",
  );

  config.chains[0].entries.forEach((entry) => {
    entry.enabled = false;
  });
  assert.equal(renderSessionStatus(config), null);

  console.log("session-status checks passed");
}

function runRateLimitMatcherChecks() {
  for (const message of [
    "429 Too Many Requests",
    "HTTP 429 request rejected",
    '{"status":429,"message":"try later"}',
    "usage limit reached",
    "rate_limit exceeded",
    "too many requests",
    "quota exhausted",
    "RESOURCE_EXHAUSTED",
  ]) {
    assert.equal(isRateLimitError(message), true, message);
  }
  for (const message of [
    "provider overloaded",
    "capacity unavailable",
    "quota information unavailable",
    "job 42901 failed",
    "HTTP 503 service unavailable",
    "400 limit reached",
  ]) {
    assert.equal(isRateLimitError(message), false, message);
  }
  console.log("rate-limit matcher checks passed");
}

async function runReplayDeliveryChecks() {
  const config = createConfig();
  const harness = new RuntimeHarness(config, ["anthropic", "anthropic-2"]);
  const prompt = "finish the migration";

  harness.startTurn(prompt, { provider: "anthropic", id: "claude-sonnet-4" });
  const rotated = await harness.handleError(
    '400 {"error":{"message":"usage limit reached"}}',
    { provider: "anthropic", id: "claude-sonnet-4" },
    prompt,
  );

  assert.equal(rotated, true);
  assert.equal(harness.snapshot().safeContinuationPending, true);
  assert.deepEqual(harness.snapshot().sentMessages, []);

  harness.settle();
  const snapshot = harness.snapshot();
  assert.deepEqual(snapshot.sentMessages, [
    {
      role: "custom",
      customType: FAILOVER_CONTINUATION_TYPE,
      content: FAILOVER_CONTINUATION_MARKER,
      display: false,
    },
  ]);
  assert.deepEqual(snapshot.sentMessageOptions, [{ triggerTurn: true }]);
  assert.equal(snapshot.sentMessages[0].content.includes(prompt), false);
  assert.equal(
    harness.expandContinuationContext(snapshot.sentMessages)[0].content,
    FAILOVER_CONTINUATION_PROMPT,
  );

  const retryHarness = new RuntimeHarness(config, ["anthropic", "anthropic-2"]);
  retryHarness.startTurn(prompt, { provider: "anthropic", id: "claude-sonnet-4" });
  assert.equal(await retryHarness.handleError(
    "429 Too Many Requests",
    { provider: "anthropic", id: "claude-sonnet-4" },
    prompt,
  ), true);
  retryHarness.finishSuccessfulTurn();
  retryHarness.settle();
  assert.deepEqual(retryHarness.snapshot().sentMessages, []);

  console.log("settled-continuation checks passed");
}

async function runRetryStartTurnChecks() {
  const config = createConfig();
  const harness = new RuntimeHarness(config, [
    "anthropic",
    "anthropic-2",
    "anthropic-3",
    "openai-codex",
    "openai-codex-2",
    "google-gemini-cli",
  ]);
  const prompt = "what model are you?";

  harness.startTurn(prompt, { provider: "anthropic", id: "claude-sonnet-4" });
  const first = await harness.handleError("429 rate limit", { provider: "anthropic", id: "claude-sonnet-4" }, prompt);
  assert.equal(first, true);

  harness.startTurn(prompt, { provider: "anthropic-2", id: "claude-sonnet-4" });
  const second = await harness.handleError("429 rate limit", { provider: "anthropic-2", id: "claude-sonnet-4" }, prompt);
  assert.equal(second, true);

  const snapshot = harness.snapshot();
  assert.deepEqual(snapshot.setModelCalls, [
    "anthropic-2:claude-sonnet-4",
    "anthropic-3:claude-sonnet-4",
  ]);
  assert.equal(
    snapshot.notifications.some(
      (entry) => entry.level === "warning" && entry.message.includes("openai-codex skipped (already attempted this turn)"),
    ),
    false,
  );

  console.log("retry-start-turn checks passed");
}

runCoreChecks();
runSessionStatusChecks();
runRateLimitMatcherChecks();
await runReplayDeliveryChecks();

if (process.argv.includes("--retry-start-turn")) {
  await runRetryStartTurnChecks();
}

if (process.argv.includes("--pool-only")) {
  await runPoolOnlyChecks();
}

if (process.argv.includes("--no-loop")) {
  await runNoLoopChecks();
}

if (process.argv.includes("--failure-path")) {
  runFailurePathChecks();
}

console.log("runtime failover checks passed");
