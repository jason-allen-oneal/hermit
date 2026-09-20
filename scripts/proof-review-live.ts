/**
 * Opt-in real Discord transport proof. Never loaded by the deployed Worker.
 * D1 is an isolated LOCAL Wrangler binding, not deployed Cloudflare D1.
 * This does not prove Discord slash-command ingress or a real Worker termination.
 * Run --preflight first. --live writes one test card; --provider also spends API credit.
 * Supply secrets through the environment, never command-line flags.
 */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { execFileSync } from "node:child_process"
import { readLiveProofConfig } from "./lib/reviewLiveProofConfig.js"
import { normalizeProofCard as normalize } from "./lib/reviewProofCard.js"

const args = new Set(process.argv.slice(2))
for (const arg of args) {
	if (!["--preflight", "--live", "--provider"].includes(arg)) throw new Error("Unknown proof option")
}
if (args.has("--live") === args.has("--preflight")) {
	throw new Error("Choose exactly one of --preflight (offline) or --live (external writes)")
}
const config = readLiveProofConfig(process.env)
if (args.has("--provider") && !process.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY")
if (args.has("--preflight")) {
	console.log("Offline configuration preflight passed. No credentials verified, no network or proof performed.")
	process.exit(0)
}

const repo = resolve(import.meta.dir, "..")
const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
const dirty = execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }).trim()
assert.equal(dirty, "", "Commit the exact proof harness and tree before a live run")
const runId = randomUUID()
const root = resolve(process.env.XDG_STATE_HOME || resolve(process.env.HOME!, ".local/state"), "hermit-live-proof", runId)
await mkdir(root, { recursive: true, mode: 0o700 })
const evidencePath = resolve(root, "evidence.jsonl")
const emit = async (event: string, detail: Record<string, unknown> = {}) => {
	const record = { at: new Date().toISOString(), runId, head, event, ...detail }
	await appendFile(evidencePath, JSON.stringify(record) + "\n", { mode: 0o600 })
	console.log(event)
}
await emit("started", {
	claim: "Real Discord delayed PATCH convergence through production notifier and recovery services",
	transport: "Carbon REST to discord.com; one PATCH held then delivered, caller acknowledgment withheld",
	database: "isolated local Wrangler D1 binding",
	configuration: "test guild/channel substituted in harness only; production configuration untouched",
	providerRequested: args.has("--provider"),
	limits: ["No deployed Worker/D1", "No Discord command/button ingress", "No actual Worker kill", "No red baseline"]
})

// Do not let production-service diagnostics print provider response bodies or identifiers.
const savedWarn = console.warn
const savedError = console.error
console.warn = () => { console.log("Production service warning (response body suppressed)") }
console.error = () => { console.log("Production service error (response body suppressed)") }
const savedFetch = globalThis.fetch
let dispose: (() => Promise<void>) | undefined
let stopBridge: (() => void) | undefined
let phase = "setup"

try {
	const { Client, Routes } = await import("@buape/carbon")
	const { getPlatformProxy } = await import("wrangler")
	const { reviewConfig } = await import("../src/config/review.js")
	const { setRuntimeEnv } = await import("../src/runtime/env.js")
	const data = await import("../src/data/review.js")
	const service = await import("../src/services/reviewNotifier.js")
	const { buildReviewCardContainer } = await import("../src/components/reviewButtons.js")
	const { serializePayload } = await import("@buape/carbon")
	const { analyze } = await import("../src/review/analyzer.js")
	const { buildReviewProofFixture } = await import("./lib/reviewProofFixture.js")
	const { applyReviewMigrations } = await import("./lib/reviewMigrationProof.js")
	const { startDiscrawlServer } = await import("../forwarder/src/discrawlServer.js")
	// This process has no inbound Discord listeners and never deploys commands.
	const client = new Client({
		clientId: config.botId, token: config.token,
		publicKey: "0".repeat(64), disableDeployRoute: true,
		baseUrl: "http://127.0.0.1", autoDeploy: false,
		requestOptions: { queueRequests: false }
	}, { commands: [] })
	Object.assign(reviewConfig, { guildId: config.guildId, reviewChannelId: config.channelId })
	process.env.ENABLE_AUTOMATIC_SCREENING = "false"

	phase = "read-only Discord scope verification"
	const bot = await client.rest.get("/users/@me") as { id: string; bot: boolean }
	assert.equal(bot.id, config.botId)
	assert.equal(bot.bot, true)
	const channel = await client.rest.get(Routes.channel(config.channelId)) as { id: string; guild_id: string; type: number }
	assert.equal(channel.id, config.channelId)
	assert.equal(channel.guild_id, config.guildId)
	assert.equal(channel.type, 0, "Use a dedicated test text channel")
	const history = await client.rest.get(Routes.channelMessages(config.channelId), { limit: 1 })
	assert(Array.isArray(history) && history.length === 0, "Use an empty dedicated proof channel; no unrelated history is inspected")
	await emit("test_scope_verified")

	phase = "isolated local D1 and authenticated fixture bridge"
	const configPath = resolve(root, "wrangler.json")
	await writeFile(configPath, JSON.stringify({
		name: "hermit-local-live-transport-proof", compatibility_date: "2026-09-08",
		compatibility_flags: ["nodejs_compat"],
		d1_databases: [{ binding: "DB", database_name: "isolated-proof", database_id: "00000000-0000-0000-0000-000000000001" }]
	}), { mode: 0o600 })
	const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath, envFiles: [], remoteBindings: false, persist: { path: resolve(root, "d1") } })
	dispose = () => proxy.dispose()
	setRuntimeEnv({ DB: proxy.env.DB } as Env)
	const db = proxy.env.DB
	const migrations = resolve(repo, "drizzle")
	await applyReviewMigrations(db, migrations, (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort())
	const fixture = buildReviewProofFixture({ guildId: config.guildId, channelId: config.channelId, targetUserId: config.botId, nowMs: Date.now() })
	const fixturePath = resolve(root, "synthetic-export.json")
	await writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o600 })
	const secret = randomUUID() + randomUUID()
	const bridge = startDiscrawlServer({ exportPath: fixturePath, secret, port: 0 })
	stopBridge = () => { bridge.stop(true) }
	delete process.env.DISCRAWL_EXPORT_PATH
	process.env.DISCRAWL_EXPORT_URL = `http://127.0.0.1:${bridge.port}`
	process.env.DISCRAWL_SECRET = secret
	const observations = await data.getRecentUserObservations(config.guildId, config.botId, 7, 100)
	assert.equal(observations.length, 24)
	const report = analyze({ guildId: config.guildId, authorId: config.botId,
		startAt: Date.now() - 7 * 86400000, endAt: Date.now(), messages: observations,
		scoreGate: { minMessages: 10, minSpanMs: 60000 } })
	assert.equal(report.priority, "review-recommended")
	await emit("authenticated_discrawl_fixture_verified", { observations: observations.length,
		families: Object.keys(report.familyScores), fixtureSha256: createHash("sha256").update(await readFile(fixturePath)).digest("hex") })

	let assessment: Awaited<ReturnType<typeof import("../src/review/krillEvaluator.js").evaluateWithKrill>> = null
	if (args.has("--provider")) {
		phase = "real provider assessment"
		globalThis.fetch = (async (input, init) => {
			const url = input instanceof Request ? input.url : String(input)
			const response = await savedFetch(input, init)
			if (url === "https://api.openai.com/v1/chat/completions") {
				const body = await response.clone().json().catch(() => ({})) as { model?: string }
				await emit("provider_response", { status: response.status,
					returnedModel: typeof body.model === "string" ? body.model : null })
			}
			return response
		}) as typeof fetch
		const { evaluateWithKrill } = await import("../src/review/krillEvaluator.js")
		assessment = await evaluateWithKrill(report)
		assert(assessment, "Real provider assessment failed; do not report provider proof")
		assert(Number.isFinite(assessment.automationProbability))
		await emit("provider_assessment_verified", { requestedModel: assessment.model,
			probability: assessment.automationProbability,
			briefSha256: createHash("sha256").update(assessment.brief).digest("hex") })
		globalThis.fetch = savedFetch
	}

	phase = "real card create and preservation control"
	const caseId = `proof-${runId}`
	let current = await data.createReviewCase({
		caseId, guildId: config.guildId, targetUserId: config.botId, status: "escalated",
		heuristicScore: report.heuristicScore ?? 0, concordance: report.concordance,
		behavioralFamilies: JSON.stringify(Object.keys(report.familyScores)),
		keySignals: JSON.stringify(report.signals.slice(0, 3).map(({ code, family, description }) => ({ code, family, description }))),
		krillBrief: assessment?.brief ?? "Synthetic real-transport proof; not a member assessment.",
		krillModel: assessment?.model ?? null,
		krillProbability: assessment ? `${(assessment.automationProbability * 100).toFixed(1)}%` : null,
		reviewChannelId: config.channelId, deliveryStatus: "pending"
	})
	assert(current)
	await service.postReviewEscalationCard(client, current)
	current = await data.getReviewCase(caseId)
	assert(current?.reviewMessageId && current.deliveryStatus === "delivered")
	const messageId = current.reviewMessageId
	const route = Routes.channelMessage(config.channelId, messageId)
	// Exact readback, not a PATCH count or success banner. Ignore Discord-generated component IDs.
	const readCard = async () => {
		const message = await client.rest.get(route) as { id: string; channel_id: string; author: { id: string; bot: boolean }; components: unknown }
		assert.equal(message.id, messageId)
		assert.equal(message.channel_id, config.channelId)
		assert.equal(message.author.id, config.botId)
		assert.equal(message.author.bot, true)
		return normalize(message.components)
	}
	const expectedCard = (row: NonNullable<typeof current>) => normalize(serializePayload({ components: [buildReviewCardContainer(row, row.status !== "escalated")] }).components)
	assert.deepEqual(await readCard(), expectedCard(current))
	await emit("real_card_create_verified", { messageId, caseId, desired: current.cardRevision, synced: current.syncedCardRevision })

	// The barrier holds only the first stale PATCH. All other I/O uses real Carbon REST.
	phase = "delayed write fault injection"
	current = await data.createReviewCase({ ...current, heuristicScore: 61 })
	assert(current)
	const patch = client.rest.patch.bind(client.rest)
	let captured: Parameters<typeof client.rest.patch> | undefined
	let captureReady!: () => void
	const barrier = new Promise<void>((resolve) => { captureReady = resolve })
	client.rest.patch = async (...parameters) => {
		assert.equal(parameters[0], route, "Unexpected PATCH target")
		captured = parameters
		client.rest.patch = patch
		captureReady()
		// Intentionally no resolve/reject: neither the production catch nor ack runs.
		return new Promise<never>(() => {})
	}
	const pendingOriginal = service.syncSharedReviewCard(client, current)
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		await Promise.race([barrier, pendingOriginal.then(() => { throw new Error("Original write returned before capture") }),
			new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("PATCH capture timed out")), 20000) })])
	} finally { clearTimeout(timer) }
	assert(captured)
	const oldPayload = normalize((captured[1]?.body as { components: unknown }).components)
	const attempt = await db.prepare("SELECT attempt_token FROM review_card_write_attempts WHERE case_id = ?").bind(caseId).first<{ attempt_token: string }>()
	assert(attempt, "Production entry point failed to persist a write obligation before transport")
	current = await data.createReviewCase({ ...current, heuristicScore: 94 })
	assert(current)
	assert.equal(await service.syncSharedReviewCard(client, current), true)
	current = await data.getReviewCase(caseId)
	assert(current)
	assert.deepEqual(await readCard(), expectedCard(current))
	await emit("newer_write_acknowledged", { desired: current.cardRevision, synced: current.syncedCardRevision })

	const runDueRecovery = async () => {
		const row = await db.prepare("SELECT next_attempt_at FROM review_card_write_attempts WHERE attempt_token = ?")
			.bind(attempt.attempt_token).first<{ next_attempt_at: string }>()
		assert(row, "Unknown original write was retired prematurely")
		// Respect actual production backoff; no fabricated due timestamps or fake clock.
		const waitMs = Math.max(0, Date.parse(row.next_attempt_at) - Date.now() + 100)
		assert(waitMs <= 130000, "Unexpected recovery backoff")
		if (waitMs) { await emit("waiting_for_production_backoff", { waitMs }); await Bun.sleep(waitMs) }
		await service.recoverOutstandingReviewCardWrites(client)
		const latest = await data.getReviewCase(caseId)
		assert(latest)
		assert.equal(latest.cardRevision, latest.syncedCardRevision)
		assert.deepEqual(await readCard(), expectedCard(latest))
		assert(await db.prepare("SELECT attempt_token FROM review_card_write_attempts WHERE attempt_token = ?").bind(attempt.attempt_token).first())
		return latest
	}
	current = await runDueRecovery()
	await emit("repair_before_delayed_original_verified", { desired: current.cardRevision, synced: current.syncedCardRevision })
	await patch(...captured)
	assert.deepEqual(await readCard(), oldPayload)
	assert.notDeepEqual(oldPayload, expectedCard(current))
	await emit("real_stale_discord_payload_observed_after_newer_ack")
	current = await runDueRecovery()
	await emit("real_discord_convergence_verified", { desired: current.cardRevision, synced: current.syncedCardRevision, originalObligationRetained: true })
	const finalHistory = await client.rest.get(Routes.channelMessages(config.channelId), { limit: 50 }) as { id: string }[]
	assert.deepEqual(finalHistory.map((message) => message.id), [messageId], "Unexpected replacement or additional card")
	await emit("passed", { noReplacementPost: true, providerExercised: Boolean(assessment),
		retained: "Test card and private local D1/evidence retained; no automatic deletion", phase })
} catch (error) {
	await emit("failed", { phase, errorType: error instanceof Error ? error.name : "unknown",
		message: "Run failed. No live-proof success is claimed; inspect private state before retrying." })
	process.exitCode = 1
} finally {
	globalThis.fetch = savedFetch
	console.warn = savedWarn
	console.error = savedError
	stopBridge?.()
	try { await dispose?.() } catch { process.exitCode = 1; await emit("cleanup_failed") }
	console.log(`Private evidence retained at ${evidencePath}; inspect/redact before publication.`)
}
