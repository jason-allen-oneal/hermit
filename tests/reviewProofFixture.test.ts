import { expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildReviewProofFixture } from "../scripts/lib/reviewProofFixture.js"
import { analyze } from "../src/review/analyzer.js"
import {
	clearDiscrawlCache,
	getRecentDiscrawlObservations,
	getDiscrawlObservationCount
} from "../src/services/discrawl.js"

const input = {
	guildId: "synthetic-guild",
	channelId: "synthetic-channel",
	targetUserId: "synthetic-target",
	nowMs: Date.parse("2026-09-19T12:00:00.000Z")
}

it("builds the same synthetic export for the same explicit inputs", () => {
	const fixture = buildReviewProofFixture(input)
	expect(fixture).toEqual(buildReviewProofFixture(input))
	expect(fixture.messages).toHaveLength(48)
	expect(new Set(fixture.messages.map((message) => message.id)).size).toBe(48)
	expect(fixture.messages.every((message) => message.content.includes("ynthetic"))).toBe(true)
})

it("drives the production Discrawl parser and unchanged review analyzer from synthetic parent/reply data", () => {
	const directory = mkdtempSync(join(tmpdir(), "hermit-review-proof-fixture-"))
	const now = spyOn(Date, "now").mockReturnValue(input.nowMs)
	try {
		const file = join(directory, "messages.json")
		writeFileSync(file, JSON.stringify(buildReviewProofFixture(input)))
		clearDiscrawlCache()
		const messages = getRecentDiscrawlObservations(file, input.guildId, input.targetUserId, 7, 100)
		expect(messages).toHaveLength(24)
		expect(getDiscrawlObservationCount(file, input.guildId, input.targetUserId, 7)).toBe(24)
		expect(messages.every((message) => message.replyLatencyMs === 1_200)).toBe(true)
		expect(messages.every((message) => message.channelId === input.channelId)).toBe(true)
		expect(messages.every((message) => message.artifacts.includes("execution-marker"))).toBe(true)
		const report = analyze({
			guildId: input.guildId,
			authorId: input.targetUserId,
			startAt: input.nowMs - 7 * 86400000,
			endAt: input.nowMs,
			messages,
			scoreGate: { minMessages: 10, minSpanMs: 60000 }
		})
		expect(report.subject).toEqual({ guildId: input.guildId, authorId: input.targetUserId })
		expect(report.sample.messages).toBeGreaterThanOrEqual(10)
		expect(report.sample.spanMs).toBeGreaterThanOrEqual(60000)
		expect(report.priority).toBe("review-recommended")
		expect(Object.keys(report.familyScores).length).toBeGreaterThanOrEqual(2)
		expect(report.familyScores.timing).toBeGreaterThan(0)
		expect(report.familyScores["operational-artifact"]).toBeGreaterThan(0)
	} finally {
		now.mockRestore()
		clearDiscrawlCache()
		rmSync(directory, { recursive: true, force: true })
	}
})
