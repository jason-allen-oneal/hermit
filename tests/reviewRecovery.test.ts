import { afterEach, beforeEach, it, mock, spyOn } from "bun:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { type Client, serializePayload } from "@buape/carbon"
import { SqliteD1Database } from "./helpers/sqliteD1.js"
import { setRuntimeEnv } from "../src/runtime/env.js"
import { reviewConfig } from "../src/config/review.js"
import * as data from "../src/data/review.js"
import type { NewReviewCase, ReviewCase } from "../src/db/schema.js"
import { ReviewDismissButton, ReviewWatchlistButton, ReviewConfirmBotButton, buildReviewCardContainer } from "../src/components/reviewButtons.js"
import {
	postReviewEscalationCard,
	syncSharedReviewCard,
	recoverReviewReceipts,
	recoverReviewEscalations,
	recoverOutstandingReviewCardWrites,
	recoverSharedCardSync
} from "../src/services/reviewNotifier.js"
import { runReviewMaintenance } from "../src/services/reviewMaintenance.js"

const BOT = "900000000000000001"
const MESSAGE = "900000000000000003"
let db: SqliteD1Database
let priorBotId: string | undefined

beforeEach(() => {
	priorBotId = process.env.DISCORD_CLIENT_ID
	process.env.DISCORD_CLIENT_ID = BOT
	db = new SqliteD1Database()
	db.database.exec(readFileSync("drizzle/0013_reflective_rictor.sql", "utf8"))
	db.database.exec(readFileSync("drizzle/0014_review_recovery_ownership.sql", "utf8"))
	db.database.exec(readFileSync("drizzle/0015_review_delivery_attempt_state.sql", "utf8"))
	db.database.exec(readFileSync("drizzle/0016_chilly_loners.sql", "utf8"))
	db.database.exec(readFileSync("drizzle/0017_optimal_leopardon.sql", "utf8"))
	setRuntimeEnv({ DB: db as unknown as D1Database })
})
afterEach(() => {
	mock.restore()
	db.close()
	if (priorBotId === undefined) delete process.env.DISCORD_CLIENT_ID
	else process.env.DISCORD_CLIENT_ID = priorBotId
})

async function seed(overrides: Partial<NewReviewCase> = {}) {
	const result = await data.createReviewCase({
		caseId: "synthetic-case", guildId: reviewConfig.guildId, targetUserId: "900000000000000002",
		status: "escalated", heuristicScore: 90, concordance: "High", behavioralFamilies: "[]",
		reviewChannelId: reviewConfig.reviewChannelId, ...overrides
	})
	assert(result)
	return result
}
async function current(caseId = "synthetic-case") {
	const result = await data.getReviewCase(caseId)
	assert(result)
	return result
}
function gate() {
	let release!: () => void
	const promise = new Promise<void>((resolve) => { release = resolve })
	return { promise, release }
}
function payload(row: ReviewCase) {
	return serializePayload({ components: [buildReviewCardContainer(row, row.status !== "escalated")], allowedMentions: { parse: [] } })
}
function fakeDiscord() {
	const cards = new Map<string, any>()
	const state = { posts: 0, patches: 0, gets: [] as string[] }
	const transport = {
		rest: {
			get: async (route: string, options?: any): Promise<any> => {
				state.gets.push(route)
				const id = route.split("/").at(-1)!
				if (id !== "messages") return cards.get(id)
				const messages = [...cards.values()]
				const start = options?.before ? messages.findIndex((item) => item.id === options.before) + 1 : 0
				return messages.slice(start, start + (options?.limit ?? 50))
			},
			post: async (_route: string, options: any): Promise<any> => {
				state.posts++
				cards.set(MESSAGE, { ...options.body, id: MESSAGE, channel_id: reviewConfig.reviewChannelId, author: { id: BOT, bot: true } })
				return { id: MESSAGE }
			},
			patch: async (route: string, options: any): Promise<any> => {
				state.patches++
				const id = route.split("/").at(-1)!
				cards.set(id, { ...options.body, id, channel_id: reviewConfig.reviewChannelId, author: { id: BOT, bot: true } })
				return { id }
			}
		}
	}
	return { transport, client: transport as unknown as Client, cards, state }
}
function setCard(fake: ReturnType<typeof fakeDiscord>, row: ReviewCase, id = MESSAGE) {
	fake.cards.set(id, { ...payload(row), id, channel_id: reviewConfig.reviewChannelId, author: { id: BOT, bot: true } })
}
const hasStatus = (fake: ReturnType<typeof fakeDiscord>, status: string, id = MESSAGE) =>
	JSON.stringify(fake.cards.get(id)).includes(`**Status:** ${status}`)
function interaction(fake: ReturnType<typeof fakeDiscord>, update: (options: any) => Promise<unknown>, messageId = MESSAGE) {
	return {
		client: fake.client, guild: { id: reviewConfig.guildId }, guildId: reviewConfig.guildId, channelId: reviewConfig.reviewChannelId,
		member: { roles: [{ id: reviewConfig.staffRoleIds[0] }] }, user: { id: "synthetic-staff" },
		userId: "synthetic-staff", message: { id: messageId }, update,
		reply: async () => { throw new Error("Unexpected rejection") }
	} as any
}

it("keeps repair pending when an old PATCH applies after a newer acknowledgment then throws", async () => {
	const old = await seed({ reviewMessageId: MESSAGE, deliveryStatus: "delivered", cardRevision: 2, syncedCardRevision: 1 })
	const fake = fakeDiscord()
	const started = gate(), release = gate()
	const patch = fake.transport.rest.patch
	let first = true
	fake.transport.rest.patch = async (route, options) => {
		if (first) {
			first = false
			started.release()
			await release.promise
			await patch(route, options)
			throw new Error("applied remotely, response lost")
		}
		return patch(route, options)
	}
	const pending = syncSharedReviewCard(fake.client, old)
	await started.promise
	await data.recordReviewCaseDecision(old.caseId, reviewConfig.guildId, old.cardRevision, {
		status: "dismissed", decidedById: "newer-staff", decisionReason: "newer decision"
	})
	await syncSharedReviewCard(fake.client, await current())
	assert.equal((await current()).syncedCardRevision, 3)
	release.release()
	assert.equal(await pending, false)
	assert(hasStatus(fake, "ESCALATED"))
	assert((await current()).cardRevision > (await current()).syncedCardRevision)
	db.database.query("UPDATE review_cases SET card_sync_next_attempt_at = NULL WHERE case_id = ?").run(old.caseId)
	await recoverSharedCardSync(fake.client)
	assert(hasStatus(fake, "DISMISSED"))
	assert.equal((await current()).cardRevision, (await current()).syncedCardRevision)
})

it("recovers a persisted PATCH attempt without waiting for the interrupted worker", async () => {
	const row = await seed({
		reviewMessageId: MESSAGE,
		deliveryStatus: "delivered",
		cardRevision: 2,
		syncedCardRevision: 1
	})
	const fake = fakeDiscord()
	setCard(fake, { ...row, cardRevision: 1, syncedCardRevision: 1 })
	const started = gate()
	const applyOld = gate()
	const oldApplied = gate()
	const neverAcknowledged = gate()
	const ordinaryPatch = fake.transport.rest.patch
	let first = true
	fake.transport.rest.patch = async (route, options) => {
		if (first) {
			first = false
			started.release()
			await applyOld.promise
			await ordinaryPatch(route, options)
			oldApplied.release()
			await neverAcknowledged.promise
			return { id: MESSAGE }
		}
		return ordinaryPatch(route, options)
	}

	void syncSharedReviewCard(fake.client, row)
	await started.promise
	const pending = db.database.query(
		"SELECT rendered_revision FROM review_card_write_attempts WHERE case_id = ?"
	).get(row.caseId) as { rendered_revision: number }
	assert.equal(pending.rendered_revision, 2)
	db.database.run(
		"UPDATE review_card_write_attempts SET next_attempt_at = ? WHERE case_id = ?",
		[new Date(Date.now() - 1_000).toISOString(), row.caseId]
	)

	await recoverOutstandingReviewCardWrites(fake.client)
	const firstRepair = await current()
	assert.equal(firstRepair.syncedCardRevision, firstRepair.cardRevision)
	assert(hasStatus(fake, "ESCALATED"))
	assert.equal(db.database.query(
		"SELECT count(*) AS count FROM review_card_write_attempts"
	).get().count, 1)
	await data.updateReviewCase(row.caseId, {
		heuristicScore: 99,
		cardRevision: firstRepair.cardRevision + 1
	})
	await recoverSharedCardSync(fake.client)
	assert(JSON.stringify(fake.cards.get(MESSAGE)).includes("99/100"))

	applyOld.release()
	await oldApplied.promise
	assert(JSON.stringify(fake.cards.get(MESSAGE)).includes("90/100"))
	db.database.run(
		"UPDATE review_card_write_attempts SET next_attempt_at = ? WHERE case_id = ?",
		[new Date(Date.now() - 1_000).toISOString(), row.caseId]
	)
	await recoverOutstandingReviewCardWrites(fake.client)
	const finalRepair = await current()
	assert.equal(finalRepair.syncedCardRevision, finalRepair.cardRevision)
	assert(JSON.stringify(fake.cards.get(MESSAGE)).includes("99/100"))
	assert.equal(db.database.query(
		"SELECT count(*) AS count FROM review_card_write_attempts"
	).get().count, 0)
})

it("keeps migrated unknown delivery history out of the new-send path", async () => {
	const stale = new Date(Date.now() - 180_000).toISOString()
	db.database.run(
		`INSERT INTO review_cases (
			case_id, guild_id, target_user_id, status, heuristic_score,
			concordance, behavioral_families, delivery_status, updated_at
		) VALUES (?, ?, ?, 'escalated', 80, 'High', '[]', 'uncertain', ?)`,
		["legacy-unknown", reviewConfig.guildId, "legacy-user", stale]
	)
	const inserted = await current("legacy-unknown")
	assert.equal(inserted.deliveryAttemptState, "legacy_unknown")
	const fake = fakeDiscord()

	await recoverReviewReceipts(fake.client)
	await recoverReviewEscalations(fake.client)

	const after = await current("legacy-unknown")
	assert.equal(after.deliveryStatus, "uncertain")
	assert.equal(after.deliveryAttemptState, "legacy_unknown")
	assert.equal(fake.state.posts, 0)
})

it("recovers a shared interaction write that applies after its first recovery", async () => {
	const row = await seed({
		reviewMessageId: MESSAGE,
		deliveryStatus: "delivered",
		cardRevision: 1,
		syncedCardRevision: 1
	})
	const fake = fakeDiscord()
	setCard(fake, row)
	const started = gate()
	const applyOld = gate()
	const oldApplied = gate()
	const neverAcknowledged = gate()
	const sharedInteraction = interaction(fake, async (options) => {
		started.release()
		await applyOld.promise
		fake.cards.set(MESSAGE, {
			...serializePayload(options),
			id: MESSAGE,
			channel_id: reviewConfig.reviewChannelId,
			author: { id: BOT, bot: true }
		})
		oldApplied.release()
		await neverAcknowledged.promise
	})

	void new ReviewDismissButton().run(sharedInteraction, {
		caseId: row.caseId,
		rev: row.cardRevision
	})
	await started.promise
	db.database.run(
		"UPDATE review_card_write_attempts SET next_attempt_at = ? WHERE case_id = ?",
		[new Date(Date.now() - 1_000).toISOString(), row.caseId]
	)
	await recoverOutstandingReviewCardWrites(fake.client)
	const firstRepair = await current()
	await data.updateReviewCase(row.caseId, {
		heuristicScore: 99,
		cardRevision: firstRepair.cardRevision + 1
	})
	await recoverSharedCardSync(fake.client)
	assert(JSON.stringify(fake.cards.get(MESSAGE)).includes("99/100"))

	applyOld.release()
	await oldApplied.promise
	assert(JSON.stringify(fake.cards.get(MESSAGE)).includes("90/100"))
	db.database.run(
		"UPDATE review_card_write_attempts SET next_attempt_at = ? WHERE case_id = ?",
		[new Date(Date.now() - 1_000).toISOString(), row.caseId]
	)
	await recoverOutstandingReviewCardWrites(fake.client)
	assert(JSON.stringify(fake.cards.get(MESSAGE)).includes("99/100"))
})

const buttons = [
	[ReviewDismissButton, "dismissed"], [ReviewWatchlistButton, "watchlist"], [ReviewConfirmBotButton, "confirmed_bot"]
] as const

it("allows exactly one staff decision for a displayed revision", async () => {
	const row = await seed()
	const [dismissed, confirmed] = await Promise.all([
		data.recordReviewCaseDecision(row.caseId, reviewConfig.guildId, row.cardRevision, {
			status: "dismissed", decidedById: "staff-a", decisionReason: "first"
		}),
		data.recordReviewCaseDecision(row.caseId, reviewConfig.guildId, row.cardRevision, {
			status: "confirmed_bot", decidedById: "staff-b", decisionReason: "second"
		})
	])
	assert.equal([dismissed, confirmed].filter(Boolean).length, 1)
	assert.notEqual((await current()).status, "escalated")
})

it("rejects wrong-guild, stale, terminal, and unversioned button actions", async () => {
	const row = await seed()
	let replies = 0
	const rejectedInteraction = (guildId: string) => ({
		client: fakeDiscord().client,
		guild: { id: guildId },
		member: { roles: [{ id: reviewConfig.staffRoleIds[0] }] },
		user: { id: "staff" },
		userId: "staff",
		message: { id: "ephemeral" },
		update: async () => { throw new Error("A rejected action must not update") },
		reply: async () => { replies++ }
	} as any)

	await new ReviewDismissButton().run(rejectedInteraction("wrong-guild"), {
		caseId: row.caseId, rev: row.cardRevision
	})
	await new ReviewDismissButton().run(rejectedInteraction(reviewConfig.guildId), {
		caseId: row.caseId
	})
	assert.equal((await current()).status, "escalated")

	const refreshed = await seed({ caseId: row.caseId, heuristicScore: 41 })
	await new ReviewDismissButton().run(rejectedInteraction(reviewConfig.guildId), {
		caseId: row.caseId, rev: row.cardRevision
	})
	assert.equal((await current()).status, "escalated")

	const decided = await data.recordReviewCaseDecision(row.caseId, reviewConfig.guildId, refreshed.cardRevision, {
		status: "dismissed", decidedById: "staff", decisionReason: "valid current action"
	})
	assert(decided)
	await new ReviewConfirmBotButton().run(rejectedInteraction(reviewConfig.guildId), {
		caseId: row.caseId, rev: decided.cardRevision
	})
	assert.equal((await current()).status, "dismissed")
	assert.equal(replies, 4)
})

it("keeps maximum supported review button IDs within Discord's limit", () => {
	const maximumCaseId = `case-${"9".repeat(19)}-${"9".repeat(19)}`
	for (const ButtonType of [ReviewDismissButton, ReviewWatchlistButton, ReviewConfirmBotButton]) {
		assert(new ButtonType(maximumCaseId, Number.MAX_SAFE_INTEGER).customId.length <= 100)
	}
})

for (const [ButtonType, disposition] of buttons) {
	it(`${disposition}: repairs an ambiguously failed shared-message interaction`, async () => {
		const row = await seed({ reviewMessageId: MESSAGE, deliveryStatus: "delivered" })
		const fake = fakeDiscord(), started = gate(), release = gate()
		const pending = new ButtonType().run(interaction(fake, async (options) => {
			started.release()
			await release.promise
			await fake.transport.rest.patch(`/channels/${reviewConfig.reviewChannelId}/messages/${MESSAGE}`, { body: serializePayload(options) })
			throw new Error("interaction applied, response lost")
		}), { caseId: row.caseId, rev: row.cardRevision })
		await started.promise
		await seed({ caseId: row.caseId, heuristicScore: 42 })
		await syncSharedReviewCard(fake.client, await current())
		release.release()
		await pending
		const result = await current()
		assert.equal(result.status, disposition)
		assert(result.cardRevision > 3)
		assert.equal(result.cardRevision, result.syncedCardRevision)
		assert(hasStatus(fake, disposition.toUpperCase()))
		assert(JSON.stringify(fake.cards.get(MESSAGE)).includes("42/100"))
	})
	it(`${disposition}: ephemeral response failure does not skip shared synchronization`, async () => {
		const row = await seed({ reviewMessageId: MESSAGE, deliveryStatus: "delivered" })
		const fake = fakeDiscord()
		await new ButtonType().run(interaction(fake, async () => { throw new Error("ephemeral response lost") }, "ephemeral-only"), { caseId: row.caseId, rev: row.cardRevision })
		assert.equal((await current()).status, disposition)
		assert.equal(fake.state.patches, 1)
		assert.equal((await current()).cardRevision, (await current()).syncedCardRevision)
		assert(hasStatus(fake, disposition.toUpperCase()))
	})
}

it("ephemeral response success never acknowledges a failed shared PATCH", async () => {
	const row = await seed({ reviewMessageId: MESSAGE, deliveryStatus: "delivered" })
	const fake = fakeDiscord()
	fake.transport.rest.patch = async () => { throw new Error("shared transport unavailable") }
	await new ReviewDismissButton().run(interaction(fake, async () => ({}), "ephemeral-only"), { caseId: row.caseId, rev: row.cardRevision })
	assert.equal((await current()).status, "dismissed")
	assert((await current()).cardRevision > (await current()).syncedCardRevision)
})

for (const status of ["dismissed", "watchlist", "confirmed_bot"] as const) {
	for (const deliveryStatus of ["uncertain", "delivering"] as const) {
		it(`recovers ${deliveryStatus} receipt after ${status} without a replacement POST`, async () => {
			const row = await seed({ status, deliveryStatus, updatedAt: new Date(Date.now() - 180_000).toISOString(), cardRevision: 2 })
			const fake = fakeDiscord()
			setCard(fake, { ...row, status: "escalated" })
			await recoverReviewReceipts(fake.client)
			const result = await current()
			assert.equal(fake.state.posts, 0)
			assert.equal(result.status, status)
			assert.equal(result.reviewMessageId, MESSAGE)
			assert.equal(result.deliveryStatus, "delivered")
			assert.equal(result.cardRevision, result.syncedCardRevision)
			assert(hasStatus(fake, status.toUpperCase()))
		})
	}
}

it("recovers an accepted POST whose response is lost after an ephemeral decision", async () => {
	const row = await seed()
	const fake = fakeDiscord(), post = fake.transport.rest.post
	fake.transport.rest.post = async (route, options) => {
		await post(route, options)
		await new ReviewDismissButton().run(interaction(fake, async () => ({}), "ephemeral-only"), { caseId: row.caseId, rev: row.cardRevision })
		throw new Error("accepted POST, response lost")
	}
	await postReviewEscalationCard(fake.client, row)
	assert.equal((await current()).status, "dismissed")
	assert.equal((await current()).reviewMessageId, null)
	db.database.query("UPDATE review_cases SET updated_at = ?, receipt_next_attempt_at = NULL WHERE case_id = ?").run(
		new Date(Date.now() - 180_000).toISOString(), row.caseId
	)
	await recoverReviewReceipts(fake.client)
	assert.equal(fake.state.posts, 1)
	assert.equal((await current()).reviewMessageId, MESSAGE)
	assert(hasStatus(fake, "DISMISSED"))
})

it("reloads the current decision when a case changes during receipt lookup", async () => {
	const row = await seed({ deliveryStatus: "uncertain", updatedAt: new Date(Date.now() - 180_000).toISOString() })
	const fake = fakeDiscord(), get = fake.transport.rest.get
	setCard(fake, row)
	fake.transport.rest.get = async (route, options) => {
		await data.recordReviewCaseDecision(row.caseId, reviewConfig.guildId, row.cardRevision, {
			status: "confirmed_bot", decidedById: "staff", decisionReason: "decided during lookup"
		})
		return get(route, options)
	}
	await recoverReviewReceipts(fake.client)
	assert.equal((await current()).status, "confirmed_bot")
	assert(hasStatus(fake, "CONFIRMED_BOT"))
	assert.equal(fake.state.posts, 0)
})

it("verifies a known uncertain receipt even when the revision pair started clean", async () => {
	const row = await seed({ status: "dismissed", reviewMessageId: MESSAGE, deliveryStatus: "uncertain", updatedAt: new Date(Date.now() - 180_000).toISOString() })
	const fake = fakeDiscord()
	setCard(fake, { ...row, status: "escalated" })
	await recoverReviewReceipts(fake.client)
	assert(fake.state.gets[0]?.endsWith(`/messages/${MESSAGE}`))
	assert.equal((await current()).deliveryStatus, "delivered")
	assert.equal(fake.state.posts, 0)
	assert(hasStatus(fake, "DISMISSED"))
})

it("clears a confirmed-deleted known receipt without replacing a decided case", async () => {
	await seed({
		status: "dismissed",
		reviewMessageId: MESSAGE,
		deliveryStatus: "uncertain",
		deliveryPostAttemptedAt: new Date(Date.now() - 180_000).toISOString(),
		updatedAt: new Date(Date.now() - 180_000).toISOString()
	})
	const fake = fakeDiscord()
	fake.transport.rest.get = async () => {
		throw Object.assign(new Error("known receipt deleted"), { status: 404 })
	}
	await recoverReviewReceipts(fake.client)
	const cleared = await current()
	assert.equal(cleared.status, "dismissed")
	assert.equal(cleared.reviewMessageId, null)
	assert.equal(cleared.deliveryStatus, "failed")
	await recoverReviewEscalations(fake.client)
	assert.equal(fake.state.posts, 0)
})

it("clears a confirmed-deleted dirty shared card instead of endlessly retrying PATCH", async () => {
	const row = await seed({
		status: "dismissed",
		reviewMessageId: MESSAGE,
		deliveryStatus: "delivered",
		cardRevision: 3,
		syncedCardRevision: 2
	})
	const fake = fakeDiscord()
	fake.transport.rest.patch = async () => {
		throw Object.assign(new Error("shared card deleted"), { status: 404 })
	}
	assert.equal(await syncSharedReviewCard(fake.client, row), false)
	const cleared = await current()
	assert.equal(cleared.reviewMessageId, null)
	assert.equal(cleared.deliveryStatus, "failed")
	assert.equal((await data.listOutOfSyncCases(
		reviewConfig.guildId,
		reviewConfig.reviewChannelId
	)).some((item) => item.caseId === row.caseId), false)
})

it("recognizes the permanent marker on a closed card with no decision buttons", async () => {
	const row = await seed({ status: "dismissed", deliveryStatus: "uncertain", updatedAt: new Date(Date.now() - 180_000).toISOString() })
	const fake = fakeDiscord()
	setCard(fake, row)
	assert(!JSON.stringify(fake.cards.get(MESSAGE)).includes("review-dismiss:caseId="))
	await recoverReviewReceipts(fake.client)
	assert.equal((await current()).reviewMessageId, MESSAGE)
})

it("preserves persisted key signals across initial delivery and canonical synchronization", async () => {
	const row = await seed({
		keySignals: JSON.stringify([{
			code: "rapid-response-speed",
			family: "timing",
			description: "Sustained response speed exceeds the configured threshold."
		}])
	})
	const fake = fakeDiscord()
	await postReviewEscalationCard(fake.client, row)
	const rendered = JSON.stringify(fake.cards.get(MESSAGE))
	assert(rendered.includes("Key Detected Signals"))
	assert(rendered.includes("rapid-response-speed"))
	assert.equal((await current()).cardRevision, (await current()).syncedCardRevision)
})

it("rejects another bot and another case whose ID merely contains the requested ID", async () => {
	const row = await seed({
		status: "dismissed",
		deliveryStatus: "uncertain",
		deliveryPostAttemptedAt: new Date(Date.now() - 180_000).toISOString(),
		updatedAt: new Date(Date.now() - 180_000).toISOString()
	})
	const fake = fakeDiscord()
	setCard(fake, { ...row, status: "escalated", caseId: row.caseId + "-other" })
	setCard(fake, row, "900000000000000004")
	fake.cards.get("900000000000000004").author.id = "other-bot"
	await recoverReviewReceipts(fake.client)
	assert.equal((await current()).reviewMessageId, null)
	assert.equal((await current()).deliveryStatus, "uncertain")
	assert.equal(fake.state.posts, 0)
	assert.equal((await data.listOutstandingReviewReceipts(reviewConfig.guildId)).length, 0)
})

it("finds a matching receipt beyond the first history page", async () => {
	const row = await seed({ deliveryStatus: "uncertain", updatedAt: new Date(Date.now() - 180_000).toISOString() })
	const fake = fakeDiscord()
	for (let index = 0; index < 50; index++) setCard(fake, { ...row, caseId: `unrelated-${index}` }, `page-one-${index}`)
	setCard(fake, row)
	await recoverReviewReceipts(fake.client)
	assert.equal(fake.state.gets.length, 2)
	assert.equal((await current()).reviewMessageId, MESSAGE)
	assert.equal(fake.state.posts, 0)
})

it("retains the last completed history page when a later page lookup fails", async () => {
	const row = await seed({ deliveryStatus: "uncertain", updatedAt: new Date(Date.now() - 180_000).toISOString() })
	const fake = fakeDiscord()
	for (let index = 0; index < 50; index++) setCard(fake, { ...row, caseId: `unrelated-${index}` }, `page-one-${index}`)
	setCard(fake, row)
	const get = fake.transport.rest.get
	let reads = 0
	fake.transport.rest.get = async (route, options) => {
		reads++
		if (reads === 2) throw new Error("second history page unavailable")
		return get(route, options)
	}
	await recoverReviewReceipts(fake.client)
	assert.equal((await current()).receiptHistoryBefore, "page-one-49")
	assert.equal((await current()).reviewMessageId, null)

	fake.transport.rest.get = get
	db.database.query("UPDATE review_cases SET receipt_next_attempt_at = NULL, updated_at = ? WHERE case_id = ?").run(
		new Date(Date.now() - 180_000).toISOString(), row.caseId
	)
	await recoverReviewReceipts(fake.client)
	assert.equal((await current()).reviewMessageId, MESSAGE)
})

it("keeps a missing receipt uncertain and applies retry backoff", async () => {
	await seed({
		status: "dismissed",
		deliveryStatus: "uncertain",
		deliveryPostAttemptedAt: new Date(Date.now() - 180_000).toISOString(),
		updatedAt: new Date(Date.now() - 180_000).toISOString()
	})
	const fake = fakeDiscord()
	await recoverReviewReceipts(fake.client)
	assert.equal(fake.state.posts, 0)
	assert.equal((await current()).deliveryStatus, "uncertain")
	assert.equal((await data.listOutstandingReviewReceipts(reviewConfig.guildId)).length, 0)
})

it("prevents an expired receipt owner from overwriting a newer adopted identity", async () => {
	const row = await seed({ deliveryStatus: "uncertain", updatedAt: new Date(Date.now() - 180_000).toISOString() })
	const oldOwner = await data.claimReviewReceiptReconciliation(row.caseId, reviewConfig.guildId, "old-owner", 1)
	assert(oldOwner)
	db.database.query("UPDATE review_cases SET receipt_claim_expires_at = ? WHERE case_id = ?").run(
		new Date(Date.now() - 1_000).toISOString(), row.caseId
	)
	const newOwner = await data.claimReviewReceiptReconciliation(row.caseId, reviewConfig.guildId, "new-owner")
	assert(newOwner)
	const decided = await data.recordReviewCaseDecision(row.caseId, reviewConfig.guildId, row.cardRevision, {
		status: "dismissed", decidedById: "staff", decisionReason: "newer"
	})
	assert(decided)
	const attached = await data.attachReviewCaseReceipt(decided, reviewConfig.reviewChannelId, MESSAGE, {
		kind: "receipt", token: "new-owner"
	})
	assert(attached)
	assert.equal(attached.status, "dismissed")
	assert(attached.cardRevision > attached.syncedCardRevision)
	assert.equal(await data.attachReviewCaseReceipt(oldOwner, reviewConfig.reviewChannelId, "different-message", {
		kind: "receipt", token: "old-owner"
	}), null)
	assert.equal((await current()).reviewMessageId, MESSAGE)
	assert.equal(await data.deferReviewReceiptReconciliation(oldOwner, "old-owner"), null)
	assert.equal((await current()).deliveryStatus, "delivered")
})

it("fences an expired delivery owner when receipt reconciliation takes ownership", async () => {
	const row = await seed({ deliveryStatus: "pending" })
	const delivery = await data.claimReviewCaseDelivery(
		row.caseId,
		reviewConfig.guildId,
		1
	)
	assert(delivery?.deliveryClaimToken)
	db.database.query("UPDATE review_cases SET delivery_claim_expires_at = ? WHERE case_id = ?").run(
		new Date(Date.now() - 1_000).toISOString(), row.caseId
	)
	const receipt = await data.claimReviewReceiptReconciliation(
		row.caseId,
		reviewConfig.guildId,
		"receipt-owner"
	)
	assert(receipt)
	assert.equal(receipt.deliveryClaimToken, null)
	assert.equal(await data.completeReviewCaseDelivery(row.caseId, delivery.deliveryClaimToken, "failed"), null)
	assert.equal(await data.deferClaimedReviewDeliveryReceipt(
		row.caseId,
		delivery.deliveryClaimToken,
		null
	), null)
	assert.equal(await data.attachReviewCaseReceipt(
		delivery,
		reviewConfig.reviewChannelId,
		"stale-delivery-message",
		{ kind: "delivery", token: delivery.deliveryClaimToken }
	), null)
	const deferred = await data.deferReviewReceiptReconciliation(receipt, "receipt-owner")
	assert(deferred)
	assert.equal(deferred.deliveryStatus, "uncertain")
})

it("preserves an ambiguous delivery generation when an expired watchlist re-escalates", async () => {
	const row = await seed({
		status: "watchlist",
		expiresAt: new Date(Date.now() - 60_000).toISOString(),
		deliveryStatus: "uncertain",
		deliveryNonce: "ambiguous-generation",
		deliveryPostAttemptedAt: new Date(Date.now() - 180_000).toISOString(),
		updatedAt: new Date(Date.now() - 180_000).toISOString()
	})
	const oldReceipt = await data.claimReviewReceiptReconciliation(
		row.caseId,
		reviewConfig.guildId,
		"old-cycle-receipt"
	)
	assert(oldReceipt)
	const reopened = await seed({ caseId: row.caseId })
	assert.equal(reopened.status, "escalated")
	assert.equal(reopened.deliveryStatus, "uncertain")
	assert.equal(reopened.deliveryPostAttemptedAt, row.deliveryPostAttemptedAt)
	assert.equal(reopened.receiptClaimToken, "old-cycle-receipt")
	assert.equal(await data.claimReviewCaseDelivery(
		row.caseId,
		reviewConfig.guildId
	), null)
	const deferred = await data.deferReviewReceiptReconciliation(
		oldReceipt,
		"old-cycle-receipt"
	)
	assert(deferred)
	const afterStaleOwner = await current()
	assert.equal(afterStaleOwner.deliveryStatus, "uncertain")
	assert.equal(afterStaleOwner.deliveryPostAttemptedAt, row.deliveryPostAttemptedAt)
	assert.equal(afterStaleOwner.deliveryNonce, "ambiguous-generation")
})

it("does not let continuous pending work starve an older failed delivery", async () => {
	const failed = await seed({ caseId: "failed-oldest", deliveryStatus: "failed" })
	db.database.query("UPDATE review_cases SET updated_at = ? WHERE case_id = ?").run(
		new Date(Date.now() - 300_000).toISOString(),
		failed.caseId
	)
	for (let index = 0; index < 6; index++) {
		await seed({ caseId: `pending-${index}`, deliveryStatus: "pending" })
	}
	const selected = await data.getUndeliveredEscalations(reviewConfig.guildId, 5)
	assert.equal(selected[0]?.caseId, failed.caseId)
	assert(selected.some((candidate) => candidate.caseId === failed.caseId))
})

it("does not claim a persisted foreign-guild case through a configured-guild wrapper", async () => {
	const foreign = await data.createReviewCase({
		caseId: "foreign-persisted",
		guildId: "foreign-guild",
		targetUserId: "foreign-target",
		status: "escalated",
		heuristicScore: 90,
		concordance: "High",
		behavioralFamilies: "[]",
		deliveryStatus: "pending"
	})
	assert(foreign)
	const fake = fakeDiscord()
	await postReviewEscalationCard(fake.client, {
		...foreign,
		guildId: reviewConfig.guildId
	})
	assert.equal(fake.state.posts, 0)
	assert.equal((await current(foreign.caseId)).deliveryStatus, "pending")
})

it("rotates a deleted receipt generation and only replaces it in a later eligible recovery", async () => {
	const row = await seed({
		reviewMessageId: MESSAGE,
		deliveryStatus: "failed",
		deliveryNonce: "old-generation-nonce"
	})
	const fake = fakeDiscord()
	fake.transport.rest.patch = async () => {
		throw Object.assign(new Error("confirmed deleted"), { status: 404 })
	}
	await postReviewEscalationCard(fake.client, row)
	const cleared = await current()
	assert.equal(fake.state.posts, 0)
	assert.equal(cleared.reviewMessageId, null)
	assert.equal(cleared.deliveryStatus, "failed")
	assert.notEqual(cleared.deliveryNonce, "old-generation-nonce")

	fake.transport.rest.patch = async (route, options) => {
		const id = route.split("/").at(-1)!
		fake.cards.set(id, {
			...options.body,
			id,
			channel_id: reviewConfig.reviewChannelId,
			author: { id: BOT, bot: true }
		})
		return { id }
	}
	let replacementNonce: string | undefined
	const post = fake.transport.rest.post
	fake.transport.rest.post = async (route, options) => {
		replacementNonce = options.body.nonce
		return post(route, options)
	}
	await recoverReviewEscalations(fake.client)
	assert.equal(fake.state.posts, 1)
	assert.equal((await current()).reviewMessageId, MESSAGE)
	assert.equal(replacementNonce, cleared.deliveryNonce)
})

it("bounds stale acknowledgment retries while leaving discoverable dirty work", async () => {
	const row = await seed({ reviewMessageId: MESSAGE, deliveryStatus: "delivered", cardRevision: 2, syncedCardRevision: 1 })
	const fake = fakeDiscord(), patch = fake.transport.rest.patch
	fake.transport.rest.patch = async (route, options) => {
		await patch(route, options)
		await seed({ caseId: row.caseId, heuristicScore: 40 + fake.state.patches })
		return {}
	}
	assert.equal(await syncSharedReviewCard(fake.client, row), false)
	assert.equal(fake.state.patches, 3)
	const deferred = await current()
	assert(deferred.cardRevision > deferred.syncedCardRevision)
	assert(deferred.cardSyncNextAttemptAt)
	db.database.query("UPDATE review_cases SET card_sync_next_attempt_at = NULL WHERE case_id = ?").run(row.caseId)
	assert((await data.listOutOfSyncCases(
		reviewConfig.guildId,
		reviewConfig.reviewChannelId
	)).some((item) => item.caseId === row.caseId))
})

it("makes assessment refresh and watchlist expiry discoverable as dirty rendered state", async () => {
	const assessment = await seed({
		caseId: "assessment-refresh",
		reviewMessageId: "assessment-message",
		deliveryStatus: "delivered",
		cardRevision: 4,
		syncedCardRevision: 4
	})
	const refreshed = await seed({ caseId: assessment.caseId, heuristicScore: 12 })
	assert.equal(refreshed.cardRevision, 5)
	assert((await data.listOutOfSyncCases(
		reviewConfig.guildId,
		reviewConfig.reviewChannelId
	)).some((item) => item.caseId === assessment.caseId))

	const watchlist = await seed({
		caseId: "watchlist-expiry",
		status: "watchlist",
		expiresAt: new Date(Date.now() - 60_000).toISOString(),
		reviewMessageId: "watchlist-message",
		deliveryStatus: "delivered",
		cardRevision: 8,
		syncedCardRevision: 8
	})
	assert.equal(await data.expireWatchlistCases(), 1)
	const expired = await current(watchlist.caseId)
	assert.equal(expired.status, "open")
	assert.equal(expired.cardRevision, 9)
	assert((await data.listOutOfSyncCases(
		reviewConfig.guildId,
		reviewConfig.reviewChannelId
	)).some((item) => item.caseId === watchlist.caseId))
})

it("does not let an earlier maintenance-stage failure skip receipt reconciliation", async () => {
	const row = await seed({ status: "dismissed", deliveryStatus: "uncertain", updatedAt: new Date(Date.now() - 180_000).toISOString() })
	const fake = fakeDiscord()
	setCard(fake, row)
	spyOn(data, "expireWatchlistCases").mockRejectedValue(new Error("expiry stage unavailable"))
	await runReviewMaintenance(fake.client)
	assert.equal((await current()).reviewMessageId, MESSAGE)
	assert.equal(fake.state.posts, 0)
})

it("continues shared-card recovery after another card fails", async () => {
	await seed({ caseId: "first", reviewMessageId: "first-message", deliveryStatus: "delivered", cardRevision: 2, syncedCardRevision: 1 })
	await seed({ caseId: "second", reviewMessageId: MESSAGE, deliveryStatus: "delivered", cardRevision: 2, syncedCardRevision: 1 })
	const fake = fakeDiscord(), patch = fake.transport.rest.patch
	fake.transport.rest.patch = async (route, options) => {
		if (route.endsWith("/first-message")) throw new Error("first card unavailable")
		return patch(route, options)
	}
	await recoverSharedCardSync(fake.client)
	assert((await current("first")).cardRevision > (await current("first")).syncedCardRevision)
	assert.equal((await current("second")).cardRevision, (await current("second")).syncedCardRevision)
})

it("filters foreign and noncanonical-channel cards before shared-card recovery", async () => {
	const valid = await seed({
		caseId: "valid-shared-card",
		reviewMessageId: "valid-message",
		deliveryStatus: "delivered",
		cardRevision: 2,
		syncedCardRevision: 1
	})
	const wrongChannel = await seed({
		caseId: "wrong-channel-card",
		reviewMessageId: "wrong-channel-message",
		reviewChannelId: "wrong-channel",
		deliveryStatus: "delivered",
		cardRevision: 2,
		syncedCardRevision: 1
	})
	const foreign = await data.createReviewCase({
		caseId: "foreign-shared-card",
		guildId: "foreign-guild",
		targetUserId: "foreign-target",
		status: "dismissed",
		heuristicScore: 90,
		concordance: "High",
		behavioralFamilies: "[]",
		reviewMessageId: "foreign-message",
		reviewChannelId: reviewConfig.reviewChannelId,
		deliveryStatus: "delivered",
		cardRevision: 2,
		syncedCardRevision: 1
	})
	assert(foreign)
	const selected = await data.listOutOfSyncCases(
		reviewConfig.guildId,
		reviewConfig.reviewChannelId
	)
	assert.deepEqual(selected.map((candidate) => candidate.caseId), [valid.caseId])
	const fake = fakeDiscord()
	assert.equal(await syncSharedReviewCard(fake.client, wrongChannel), false)
	assert.equal(fake.state.patches, 0)
	await recoverSharedCardSync(fake.client)
	assert.equal(fake.state.patches, 1)
	assert.equal((await current(valid.caseId)).syncedCardRevision, 2)
	assert.equal((await current(wrongChannel.caseId)).syncedCardRevision, 1)
	assert.equal((await current(foreign.caseId)).syncedCardRevision, 1)
})

it("preserves repair work when an old re-escalation PATCH applies and loses its response", async () => {
	const row = await seed({ reviewMessageId: MESSAGE, deliveryStatus: "pending" })
	const fake = fakeDiscord(), started = gate(), release = gate()
	const patch = fake.transport.rest.patch
	let first = true
	fake.transport.rest.patch = async (route, options) => {
		if (first) {
			first = false
			started.release()
			await release.promise
			await patch(route, options)
			throw new Error("re-escalation applied, response lost")
		}
		return patch(route, options)
	}
	const pending = postReviewEscalationCard(fake.client, row)
	await started.promise
	const allocated = await current(row.caseId)
	await data.recordReviewCaseDecision(row.caseId, reviewConfig.guildId, allocated.cardRevision, {
		status: "dismissed", decidedById: "staff", decisionReason: "newer decision"
	})
	await syncSharedReviewCard(fake.client, await current())
	release.release()
	await pending
	assert((await current()).cardRevision > (await current()).syncedCardRevision)
	db.database.query("UPDATE review_cases SET card_sync_next_attempt_at = NULL WHERE case_id = ?").run(row.caseId)
	await recoverSharedCardSync(fake.client)
	assert(hasStatus(fake, "DISMISSED"))
	assert.equal(fake.state.posts, 0)
})

it("surfaces a failure to persist ambiguous-write repair instead of returning success", async () => {
	const row = await seed({ reviewMessageId: MESSAGE, deliveryStatus: "delivered", cardRevision: 2, syncedCardRevision: 1 })
	const fake = fakeDiscord()
	fake.transport.rest.patch = async () => { throw new Error("transport response lost") }
	spyOn(data, "markReviewCardStaleWrite").mockRejectedValue(new Error("repair persistence unavailable"))
	await assert.rejects(() => syncSharedReviewCard(fake.client, row), /Failed to persist ambiguous shared-card repair/)
	assert((await current()).cardRevision > (await current()).syncedCardRevision)
})

it("keeps an adopted receipt dirty when its first canonical PATCH fails", async () => {
	const row = await seed({ status: "dismissed", deliveryStatus: "uncertain", updatedAt: new Date(Date.now() - 180_000).toISOString() })
	const fake = fakeDiscord(), patch = fake.transport.rest.patch
	setCard(fake, { ...row, status: "escalated" })
	fake.transport.rest.patch = async () => { throw new Error("PATCH unavailable after receipt persisted") }
	await recoverReviewReceipts(fake.client)
	assert.equal((await current()).reviewMessageId, MESSAGE)
	assert.equal((await current()).deliveryStatus, "delivered")
	assert((await current()).cardRevision > (await current()).syncedCardRevision)
	fake.transport.rest.patch = patch
	db.database.query("UPDATE review_cases SET card_sync_next_attempt_at = NULL WHERE case_id = ?").run(row.caseId)
	await recoverSharedCardSync(fake.client)
	assert(hasStatus(fake, "DISMISSED"))
	assert.equal(fake.state.posts, 0)
})

it("treats exhausted history budget as unresolved without posting a replacement", async () => {
	const row = await seed({ status: "dismissed", deliveryStatus: "uncertain", updatedAt: new Date(Date.now() - 180_000).toISOString() })
	const fake = fakeDiscord()
	for (let index = 0; index < 250; index++) setCard(fake, { ...row, caseId: `unrelated-${index}` }, `history-${index}`)
	setCard(fake, row)
	await recoverReviewReceipts(fake.client)
	assert.equal(fake.state.gets.length, 5)
	assert.equal((await current()).reviewMessageId, null)
	assert.equal((await current()).deliveryStatus, "uncertain")
	assert.equal(fake.state.posts, 0)
	assert.equal((await data.listOutstandingReviewReceipts(reviewConfig.guildId)).length, 0)
	const cursor = (await current()).receiptHistoryBefore
	assert.equal(cursor, "history-249")
	db.database.query("UPDATE review_cases SET receipt_next_attempt_at = NULL, updated_at = ? WHERE case_id = ?").run(
		new Date(Date.now() - 180_000).toISOString(), row.caseId
	)
	await recoverReviewReceipts(fake.client)
	assert.equal((await current()).reviewMessageId, MESSAGE)
})

it("releases an exhaustively scanned unattempted delivery and posts once without rescanning", async () => {
	const row = await seed({ deliveryStatus: "pending" })
	const fake = fakeDiscord()
	for (let index = 0; index < 250; index++) {
		setCard(fake, { ...row, caseId: `unrelated-${index}` }, `unrelated-history-${index}`)
	}

	await postReviewEscalationCard(fake.client, row)
	let unresolved = await current()
	assert.equal(fake.state.gets.length, 5)
	assert.equal(fake.state.posts, 0)
	assert.equal(unresolved.deliveryStatus, "uncertain")
	assert.equal(unresolved.deliveryPostAttemptedAt, null)
	assert.equal(unresolved.receiptHistoryBefore, "unrelated-history-249")

	db.database.query("UPDATE review_cases SET receipt_next_attempt_at = NULL, updated_at = ? WHERE case_id = ?").run(
		new Date(Date.now() - 180_000).toISOString(), row.caseId
	)
	await recoverReviewReceipts(fake.client)
	const released = await current()
	assert.equal(fake.state.gets.length, 6)
	assert.equal(released.deliveryStatus, "failed")
	assert(released.deliveryPreflightCompletedAt)

	await recoverReviewEscalations(fake.client)
	const delivered = await current()
	assert.equal(fake.state.gets.length, 6)
	assert.equal(fake.state.posts, 1)
	assert.equal(delivered.deliveryStatus, "delivered")
	assert.equal(delivered.reviewMessageId, MESSAGE)
})
