import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import { Container, TextDisplay } from "@buape/carbon"
import { contentFeatures, conversationalText } from "../src/review/features.js"
import { timingSignals } from "../src/review/timing.js"
import { analyze } from "../src/review/analyzer.js"
import { evaluateWithKrill } from "../src/review/krillEvaluator.js"
import {
	ReviewDismissButton,
	ReviewWatchlistButton,
	ReviewConfirmBotButton,
	buildReviewCardContainer
} from "../src/components/reviewButtons.js"
import ReviewCommand from "../src/commands/review.js"
import { reviewConfig } from "../src/config/review.js"
import * as reviewData from "../src/data/review.js"
import {
	postReviewEscalationCard,
	recoverSharedCardSync,
	syncSharedReviewCard
} from "../src/services/reviewNotifier.js"
import ReviewIngestMessageCreate from "../src/events/reviewIngestMessageCreate.js"
import type { ReviewCase } from "../src/db/schema.js"
import type { AnalysisReport, ReviewMessage } from "../src/review/types.js"

const TEST_KEY = "test-secret-key-that-is-at-least-32-chars-long"

describe("Claw & Order / Hermit Review Pipeline", () => {
	describe("Feature Extraction (features.ts)", () => {
		it("extracts AI thought streams and marks execution-marker & ai-formatting", () => {
			const thoughtContent = `> 🧠 **Thinking Process**\n> 1. Formulate step\n> 2. Plan action\n\nHere is the resolution:\n* **Step 1:** Run check\n* **Step 2:** Verify output`
			const features = contentFeatures(
				thoughtContent,
				TEST_KEY,
				"guild-1",
				"author-1"
			)

			expect(features.artifacts).toContain("execution-marker")
			expect(features.artifacts).toContain("ai-formatting")
			expect(features.artifacts).not.toContain("human-conversational")
		})

		it("preserves AI thought stream lines while stripping block quotes", () => {
			const text = conversationalText(
				"> normal block quote to discard\n> 🧠 Thinking through the problem\nHello world!"
			)
			expect(text).toContain("🧠 Thinking through the problem")
			expect(text).not.toContain("normal block quote")
			expect(text).toContain("Hello world!")
		})

		it("marks human conversational markers for informal human speech", () => {
			const content = "idk tbh that looks kinda sus ngl lol"
			const features = contentFeatures(
				content,
				TEST_KEY,
				"guild-1",
				"author-human"
			)

			expect(features.artifacts).toContain("human-conversational")
			expect(features.artifacts).not.toContain("execution-marker")
			expect(features.artifacts).not.toContain("ai-formatting")
		})
	})

	describe("Timing Analysis (timing.ts)", () => {
		it("detects rapid superhuman response speed", () => {
			const baseTime = Date.now()
			const messages: ReviewMessage[] = [
				{
					guildId: "g1",
					messageId: "m1",
					authorId: "a1",
					channelId: "c1",
					createdAt: baseTime,
					replyToId: "p1",
					replyLatencyMs: 1200, // 1.2s
					contentLength: 600, // 500 chars/sec
					lineCount: 10,
					fingerprint: "fp1",
					artifacts: ["ai-formatting"]
				},
				{
					guildId: "g1",
					messageId: "m2",
					authorId: "a1",
					channelId: "c1",
					createdAt: baseTime + 5000,
					replyToId: "p2",
					replyLatencyMs: 1500,
					contentLength: 750,
					lineCount: 12,
					fingerprint: "fp2",
					artifacts: ["ai-formatting"]
				},
				{
					guildId: "g1",
					messageId: "m3",
					authorId: "a1",
					channelId: "c1",
					createdAt: baseTime + 10000,
					replyToId: "p3",
					replyLatencyMs: 1800,
					contentLength: 800,
					lineCount: 15,
					fingerprint: "fp3",
					artifacts: ["ai-formatting"]
				},
				{
					guildId: "g1",
					messageId: "m4",
					authorId: "a1",
					channelId: "c1",
					createdAt: baseTime + 15000,
					replyToId: "p4",
					replyLatencyMs: 1400,
					contentLength: 650,
					lineCount: 11,
					fingerprint: "fp4",
					artifacts: ["ai-formatting"]
				}
			]

			const signals = timingSignals(messages)
			const rapidSignal = signals.find((s) => s.code === "rapid-response-speed")
			expect(rapidSignal).toBeDefined()
			expect(rapidSignal?.family).toBe("timing")
			expect(rapidSignal?.points).toBe(30)
		})
	})

	describe("Analyzer (analyzer.ts)", () => {
		it("escalates multi-family AI agent pattern to review-recommended", () => {
			const start = Date.now() - 3600000
			const messages: ReviewMessage[] = []

			for (let i = 0; i < 25; i++) {
				messages.push({
					guildId: "g1",
					messageId: `msg-${i}`,
					authorId: "rowan-bot",
					channelId: i % 2 === 0 ? "c1" : "c2",
					createdAt: start + i * 120000,
					replyToId: `parent-${i}`,
					replyLatencyMs: 1200,
					contentLength: 500,
					lineCount: 10,
					fingerprint: `fp-${i}`,
					artifacts: [
						"execution-marker",
						"ai-formatting",
						"ai-discourse"
					]
				})
			}

			const report = analyze({
				guildId: "g1",
				authorId: "rowan-bot",
				startAt: start,
				endAt: start + 3600000,
				messages,
				scoreGate: { minMessages: 20, minSpanMs: 30 * 60000 }
			})

			expect(report.priority).toBe("review-recommended")
			expect(report.concordance).toBe("High")
			expect(report.heuristicScore).toBeGreaterThanOrEqual(50)
			expect(report.familyScores["timing"]).toBeDefined()
			expect(report.familyScores["operational-artifact"]).toBeDefined()
			expect(report.familyScores["stylometry"]).toBeDefined()
		})

		it("blocks human user with isolated stylometry from escalation via 2-family gate", () => {
			const start = Date.now() - 3600000
			const messages: ReviewMessage[] = []

			for (let i = 0; i < 25; i++) {
				messages.push({
					guildId: "g1",
					messageId: `human-msg-${i}`,
					authorId: "human-user",
					channelId: "c1",
					createdAt: start + i * 120000,
					replyToId: null,
					replyLatencyMs: null,
					contentLength: 40,
					lineCount: 1,
					fingerprint: `human-fp-${i}`,
					artifacts: ["human-conversational"]
				})
			}

			const report = analyze({
				guildId: "g1",
				authorId: "human-user",
				startAt: start,
				endAt: start + 3600000,
				messages,
				scoreGate: { minMessages: 20, minSpanMs: 30 * 60000 }
			})

			expect(report.priority).toBe("no-strong-indicators")
			expect(report.concordance).toBe("None")
			expect(report.heuristicScore).toBe(0)
		})
	})

	describe("Krill Tier 2 Evaluator (krillEvaluator.ts)", () => {
		const originalFetch = globalThis.fetch

		afterEach(() => {
			globalThis.fetch = originalFetch
		})

		it("evaluates suspect report with gpt-6-astra low-thinking and returns calibrated probability", async () => {
			const mockResponse = {
				choices: [
					{
						message: {
							content: JSON.stringify({
								automationProbability: 0.994,
								confidence: "high",
								brief:
									"Account exhibits synthetic thought tags (> 🧠 Thinking Process) and superhuman delivery rate exceeding 1,100 chars/second. Profile is consistent with autonomous agent execution.",
								disposition: "confirmed_bot",
								recommendedAction: "apply_bot_role"
							})
						}
					}
				]
			}

			globalThis.fetch = async (url: any, init: any) => {
				const body = JSON.parse(init.body)
				expect(body.model).toBe("gpt-6-astra")
				expect(body.reasoning_effort).toBe("low")
				return new Response(JSON.stringify(mockResponse), { status: 200 })
			}

			const sampleReport: AnalysisReport = {
				detectorVersion: "hermit-v1.0",
				subject: { guildId: "g1", authorId: "target-1" },
				window: { startAt: Date.now() - 3600000, endAt: Date.now() },
				sample: {
					messages: 30,
					channels: 2,
					spanMs: 3600000,
					truncated: false
				},
				priority: "review-recommended",
				heuristicScore: 100,
				concordance: "High",
				familyScores: {
					timing: 30,
					"operational-artifact": 35,
					stylometry: 35
				},
				signals: [
					{
						code: "rapid-response-speed",
						family: "timing",
						points: 30,
						description: "Superhuman response speed",
						messageIds: ["m1"],
						metrics: { medianSpeedCharsPerSec: 1161 },
						alternative: "Automation or streaming"
					},
					{
						code: "operational-markers",
						family: "operational-artifact",
						points: 35,
						description: "Execution markers detected",
						messageIds: ["m2"],
						metrics: { messages: 12 },
						alternative: "Logs or testing"
					}
				],
				limitations: []
			}

			const result = await evaluateWithKrill(sampleReport, "mock-api-key")
			expect(result).not.toBeNull()
			expect(result?.automationProbability).toBe(0.994)
			expect(result?.confidence).toBe("high")
			expect(result?.brief).toContain("superhuman delivery rate")
			expect(result?.disposition).toBe("confirmed_bot")
			expect(result?.recommendedAction).toBe("apply_bot_role")
			expect(result?.model).toBe("gpt-6-astra")
		})
	})

	describe("Review Card Rendering (reviewButtons.ts)", () => {
		it("renders review card container with Carbon components", () => {
			const reviewCase: ReviewCase = {
				id: 1,
				caseId: "case-g1-u1",
				guildId: "g1",
				targetUserId: "u1",
				status: "escalated",
				heuristicScore: 95,
				concordance: "High",
				behavioralFamilies: JSON.stringify(["timing", "stylometry"]),
				evidenceMessageId: "m1",
				krillProbability: "99.4%",
				krillBrief: "Autonomous agent execution confirmed.",
				krillModel: "gpt-6-astra",
				reviewMessageId: null,
				reviewChannelId: "1519064274561929328",
				deliveryStatus: "pending",
				expiresAt: null,
				decidedById: null,
				decisionReason: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			}

			const container = buildReviewCardContainer(reviewCase, null, null, false)
			expect(container).toBeDefined()
			expect(container.components.length).toBeGreaterThan(3)
		})

		it("displays watchlist expiration timestamp when on watchlist", () => {
			const expires = new Date(Date.now() + 7 * 86400000).toISOString()
			const reviewCase: ReviewCase = {
				id: 2,
				caseId: "case-g1-u2",
				guildId: "g1",
				targetUserId: "u2",
				status: "watchlist",
				heuristicScore: 80,
				concordance: "High",
				behavioralFamilies: JSON.stringify(["timing"]),
				evidenceMessageId: "m2",
				krillProbability: "85%",
				krillBrief: "Watchlist evaluation.",
				krillModel: "gpt-6-astra",
				reviewMessageId: "msg-1",
				reviewChannelId: "1519064274561929328",
				deliveryStatus: "delivered",
				expiresAt: expires,
				decidedById: "staff-1",
				decisionReason: "Added to watchlist for 7 days.",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			}

			const container = buildReviewCardContainer(reviewCase, null, null, true)
			const statusDisplay = container.components.find(
				(c) => c instanceof TextDisplay && (c as any).content?.includes("WATCHLIST")
			)
			expect(statusDisplay).toBeDefined()
		})
	})

	describe("Review Buttons Dispatch & Routing (reviewButtons.ts)", () => {
		const staffRoleId = reviewConfig.staffRoleIds[0]

		it("configures distinct customIds and defer=false across all actions", () => {
			const dismiss = new ReviewDismissButton("case-101")
			const watchlist = new ReviewWatchlistButton("case-101")
			const confirmBot = new ReviewConfirmBotButton("case-101")

			expect(dismiss.customId).toBe("review-dismiss:caseId=case-101")
			expect(dismiss.defer).toBe(false)

			expect(watchlist.customId).toBe("review-watchlist:caseId=case-101")
			expect(watchlist.defer).toBe(false)

			expect(confirmBot.customId).toBe("review-confirm-bot:caseId=case-101")
			expect(confirmBot.defer).toBe(false)
		})

		it("rejects non-staff interactions with Carbon Container notice", async () => {
			const dismiss = new ReviewDismissButton("case-101")
			let repliedPayload: any = null

			const mockInteraction = {
				member: { roles: [{ id: "unrelated-role" }] },
				user: { id: "non-staff-user" },
				userId: "non-staff-user",
				reply: async (payload: any) => {
					repliedPayload = payload
				}
			} as unknown as any

			await dismiss.run(mockInteraction, { caseId: "case-101" })

			expect(repliedPayload).toBeDefined()
			expect(repliedPayload.ephemeral).toBe(true)
			expect(repliedPayload.components[0] instanceof Container).toBe(true)
			expect(repliedPayload.components[0].accentColor).toBe("#f85149")
		})

		it("dismisses case for staff and updates card without deferring", async () => {
			const dismiss = new ReviewDismissButton("case-101")
			let updateCaseArgs: any = null
			let updatedMessagePayload: any = null

			spyOn(reviewData, "updateReviewCase").mockImplementation(
				async (caseId, update) => {
					updateCaseArgs = { caseId, update }
					return {
						id: 1,
						caseId,
						guildId: reviewConfig.guildId,
						targetUserId: "target-1",
						status: "dismissed",
						heuristicScore: 70,
						concordance: "High",
						behavioralFamilies: "[]",
						evidenceMessageId: null,
						krillProbability: null,
						krillBrief: null,
						krillModel: null,
						reviewMessageId: null,
						reviewChannelId: null,
						deliveryStatus: "delivered",
						expiresAt: null,
						decidedById: "staff-1",
						decisionReason: "Marked as human / dismissed by staff.",
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					}
				}
			)

			const mockInteraction = {
				member: { roles: [{ id: staffRoleId }] },
				user: { id: "staff-1" },
				userId: "staff-1",
				update: async (payload: any) => {
					updatedMessagePayload = payload
				}
			} as unknown as any

			await dismiss.run(mockInteraction, { caseId: "case-101" })

			expect(updateCaseArgs.caseId).toBe("case-101")
			expect(updateCaseArgs.update.status).toBe("dismissed")
			expect(updateCaseArgs.update.expiresAt).toBeNull()
			expect(updatedMessagePayload).toBeDefined()
			expect(updatedMessagePayload.components[0] instanceof Container).toBe(true)
		})

		it("places case on 7-day watchlist with expiration timestamp", async () => {
			const watchlist = new ReviewWatchlistButton("case-202")
			let updateCaseArgs: any = null

			spyOn(reviewData, "updateReviewCase").mockImplementation(
				async (caseId, update) => {
					updateCaseArgs = { caseId, update }
					return {
						id: 2,
						caseId,
						guildId: reviewConfig.guildId,
						targetUserId: "target-2",
						status: "watchlist",
						heuristicScore: 75,
						concordance: "High",
						behavioralFamilies: "[]",
						evidenceMessageId: null,
						krillProbability: null,
						krillBrief: null,
						krillModel: null,
						reviewMessageId: null,
						reviewChannelId: null,
						deliveryStatus: "delivered",
						expiresAt: update.expiresAt ?? null,
						decidedById: "staff-1",
						decisionReason: "Added to watchlist for 7 days.",
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					}
				}
			)

			const mockInteraction = {
				member: { roles: [{ id: staffRoleId }] },
				user: { id: "staff-1" },
				userId: "staff-1",
				update: async () => {}
			} as unknown as any

			await watchlist.run(mockInteraction, { caseId: "case-202" })

			expect(updateCaseArgs.caseId).toBe("case-202")
			expect(updateCaseArgs.update.status).toBe("watchlist")
			expect(updateCaseArgs.update.expiresAt).toBeDefined()
			const expiresDate = new Date(updateCaseArgs.update.expiresAt).getTime()
			expect(expiresDate).toBeGreaterThan(Date.now() + 6 * 86400000)
		})

		it("synchronizes shared review card when decided from an ephemeral command card", async () => {
			const confirmBot = new ReviewConfirmBotButton("case-303")
			let patchedMessageRoute: string | null = null
			let patchedPayload: any = null

			spyOn(reviewData, "updateReviewCase").mockResolvedValue({
				id: 3,
				caseId: "case-303",
				guildId: reviewConfig.guildId,
				targetUserId: "target-bot-3",
				status: "confirmed_bot",
				heuristicScore: 100,
				concordance: "High",
				behavioralFamilies: "[]",
				evidenceMessageId: null,
				krillProbability: "99.8%",
				krillBrief: "Agent verified",
				krillModel: "gpt-6-astra",
				reviewMessageId: "shared-channel-msg-999",
				reviewChannelId: reviewConfig.reviewChannelId,
				deliveryStatus: "delivered",
				expiresAt: null,
				decidedById: "staff-1",
				decisionReason: "Confirmed automated agent account.",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			})

			const mockInteraction = {
				member: { roles: [{ id: staffRoleId }] },
				user: { id: "staff-1" },
				userId: "staff-1",
				message: { id: "ephemeral-command-card-111" },
				client: {
					rest: {
						patch: async (route: string, options: any) => {
							patchedMessageRoute = route
							patchedPayload = options.body
							return {}
						}
					}
				},
				update: async () => {}
			} as unknown as any

			await confirmBot.run(mockInteraction, { caseId: "case-303" })

			expect(patchedMessageRoute).toContain("shared-channel-msg-999")
			expect(patchedPayload).toBeDefined()
			expect(patchedPayload.components[0].components.length).toBeGreaterThan(0)
		})
	})

	describe("Review Command (review.ts)", () => {
		const staffRoleId = reviewConfig.staffRoleIds[0]

		it("reads user option via getUser and enforces community guild boundary", async () => {
			const cmd = new ReviewCommand()
			let getUserCalled = false
			let repliedPayload: any = null

			const mockInteractionForeignGuild = {
				guild: { id: "foreign-guild-123" },
				member: { roles: [{ id: staffRoleId }] },
				options: {
					getUser: () => {
						getUserCalled = true
						return { id: "target-user-1" }
					},
					getBoolean: () => false
				},
				reply: async (payload: any) => {
					repliedPayload = payload
				}
			} as unknown as any

			await cmd.run(mockInteractionForeignGuild)

			expect(getUserCalled).toBe(false)
			expect(repliedPayload).toBeDefined()
			expect(repliedPayload.components[0] instanceof Container).toBe(true)
			expect(repliedPayload.components[0].accentColor).toBe("#f85149")
		})
	})

	describe("Guild Boundary & Periodic Trigger (reviewIngestMessageCreate.ts)", () => {
		it("drops foreign guild messages immediately without recording observations", async () => {
			const listener = new ReviewIngestMessageCreate()
			let recordCalled = false

			spyOn(reviewData, "recordObservation").mockImplementation(async () => {
				recordCalled = true
				return null
			})

			await listener.handle(
				{
					id: "msg-foreign-1",
					guild_id: "other-guild-999",
					channel_id: "channel-1",
					author: { id: "user-1" },
					content: "normal message",
					timestamp: new Date().toISOString()
				} as any,
				{} as any
			)

			expect(recordCalled).toBe(false)
		})

		it("triggers evaluation on periodic count (every 10 messages) without tool markers", async () => {
			const listener = new ReviewIngestMessageCreate()
			let evaluatedReport = false

			spyOn(reviewData, "recordObservation").mockImplementation(async (obs) => {
				return { ...obs, id: 10, artifacts: "[]", similarity: null, semanticScore: null, receivedAt: new Date().toISOString() }
			})

			spyOn(reviewData, "getUserObservationCount").mockResolvedValue(10)
			spyOn(reviewData, "getReviewCase").mockResolvedValue(null)
			spyOn(reviewData, "getRecentUserObservations").mockImplementation(async () => {
				evaluatedReport = true
				return []
			})

			await listener.handle(
				{
					id: "msg-comm-10",
					guild_id: reviewConfig.guildId,
					channel_id: "channel-1",
					author: { id: "user-stylometry-only" },
					content: "normal message with no tool markers at all",
					timestamp: new Date().toISOString()
				} as any,
				{} as any
			)

			expect(evaluatedReport).toBe(true)
		})
	})

	describe("Review Notifier & Recovery (reviewNotifier.ts)", () => {
		it("strictly rejects posting escalation cards for foreign guilds", async () => {
			let postCalled = false
			const mockClient = {
				rest: {
					post: async () => {
						postCalled = true
						return { id: "discord-msg-1" }
					}
				}
			} as unknown as any

			const foreignCase: ReviewCase = {
				id: 99,
				caseId: "case-foreign-1",
				guildId: "foreign-guild-999",
				targetUserId: "u1",
				status: "escalated",
				heuristicScore: 90,
				concordance: "High",
				behavioralFamilies: "[]",
				evidenceMessageId: null,
				krillProbability: null,
				krillBrief: null,
				krillModel: null,
				reviewMessageId: null,
				reviewChannelId: null,
				deliveryStatus: "pending",
				expiresAt: null,
				decidedById: null,
				decisionReason: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			}

			await postReviewEscalationCard(mockClient, foreignCase, null, null)
			expect(postCalled).toBe(false)
		})

		it("claims delivery atomically and marks deliveryStatus=uncertain on network error", async () => {
			let updatedStatus: string | null = null

			const validCase: ReviewCase = {
				id: 1,
				caseId: "case-valid-1",
				guildId: reviewConfig.guildId,
				targetUserId: "u1",
				status: "escalated",
				heuristicScore: 90,
				concordance: "High",
				behavioralFamilies: "[]",
				evidenceMessageId: null,
				krillProbability: null,
				krillBrief: null,
				krillModel: null,
				reviewMessageId: null,
				reviewChannelId: null,
				deliveryStatus: "pending",
				expiresAt: null,
				decidedById: null,
				decisionReason: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			}

			spyOn(reviewData, "claimReviewCaseDelivery").mockResolvedValue(validCase)
			spyOn(reviewData, "updateReviewCase").mockImplementation(async (caseId, update) => {
				if (update.deliveryStatus) updatedStatus = update.deliveryStatus
				return null
			})

			const mockClient = {
				rest: {
					get: async () => [],
					post: async () => {
						throw new Error("Discord Gateway Timeout 504")
					}
				}
			} as unknown as any

			await postReviewEscalationCard(mockClient, validCase, null, null)
			expect(updatedStatus).toBe("uncertain")
		})

		it("reconciles uncertain send without duplicate POST when card exists", async () => {
			const origClientId = process.env.DISCORD_CLIENT_ID
			process.env.DISCORD_CLIENT_ID = "bot-hermit-1"
			try {
				let postCount = 0
				let markedDelivered = false

				const uncertainCase: ReviewCase = {
					id: 1,
					caseId: "case-uncertain-1",
					guildId: reviewConfig.guildId,
					targetUserId: "target-user-rec",
					status: "escalated",
					heuristicScore: 90,
					concordance: "High",
					behavioralFamilies: "[]",
					evidenceMessageId: null,
					krillProbability: null,
					krillBrief: null,
					krillModel: null,
					reviewMessageId: null,
					reviewChannelId: reviewConfig.reviewChannelId,
					deliveryStatus: "uncertain",
					cardRevision: 1,
					syncedCardRevision: 1,
					expiresAt: null,
					decidedById: null,
					decisionReason: null,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString()
				}

				spyOn(reviewData, "claimReviewCaseDelivery").mockResolvedValue(uncertainCase)
				spyOn(reviewData, "updateReviewCase").mockImplementation(async (caseId, update) => {
					if (update.deliveryStatus === "delivered" && update.reviewMessageId === "existing-card-123") {
						markedDelivered = true
					}
					return null
				})

				const mockClient = {
					rest: {
						get: async () => [
							{
								id: "existing-card-123",
								author: { id: "bot-hermit-1", bot: true },
								components: [{ content: "🦞 Claw & Order | Automation Review\ncaseId=case-uncertain-1\ntarget-user-rec" }]
							}
						],
						post: async () => {
							postCount++
							return { id: "new-card-456" }
						}
					}
				} as unknown as any

				await postReviewEscalationCard(mockClient, uncertainCase, null, null)
				expect(markedDelivered).toBe(true)
				expect(postCount).toBe(0) // Reconciled read-only without duplicate POST
			} finally {
				process.env.DISCORD_CLIENT_ID = origClientId
			}
		})

		it("strictly rejects adopting foreign bot messages during reconciliation", async () => {
			const origClientId = process.env.DISCORD_CLIENT_ID
			process.env.DISCORD_CLIENT_ID = "bot-hermit-1"
			try {
				let postCount = 0
				let markedDelivered = false

				const uncertainCase: ReviewCase = {
					id: 1,
					caseId: "case-foreign-bot",
					guildId: reviewConfig.guildId,
					targetUserId: "target-user-rec",
					status: "escalated",
					heuristicScore: 90,
					concordance: "High",
					behavioralFamilies: "[]",
					evidenceMessageId: null,
					krillProbability: null,
					krillBrief: null,
					krillModel: null,
					reviewMessageId: null,
					reviewChannelId: reviewConfig.reviewChannelId,
					deliveryStatus: "uncertain",
					cardRevision: 1,
					syncedCardRevision: 1,
					expiresAt: null,
					decidedById: null,
					decisionReason: null,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString()
				}

				spyOn(reviewData, "claimReviewCaseDelivery").mockResolvedValue(uncertainCase)
				spyOn(reviewData, "updateReviewCase").mockImplementation(async (caseId, update) => {
					if (update.deliveryStatus === "delivered") {
						markedDelivered = true
					}
					return null
				})

				const mockClient = {
					rest: {
						get: async () => [
							{
								id: "foreign-card-789",
								author: { id: "foreign-bot-999", bot: true },
								components: [{ content: "🦞 Claw & Order | Automation Review\ncaseId=case-foreign-bot\ntarget-user-rec" }]
							}
						],
						post: async () => {
							postCount++
							return { id: "new-card-456" }
						}
					}
				} as unknown as any

				await postReviewEscalationCard(mockClient, uncertainCase, null, null)
				expect(markedDelivered).toBe(false)
				expect(postCount).toBe(0) // Uncertain status preserved without duplicate post
			} finally {
				process.env.DISCORD_CLIENT_ID = origClientId
			}
		})

		it("reopens existing card when a watchlist case escalates again", async () => {
			let patchCalled = false
			let postCalled = false
			let patchedMessageId: string | null = null

			const watchlistReEscalatedCase: ReviewCase = {
				id: 2,
				caseId: "case-watchlist-again",
				guildId: reviewConfig.guildId,
				targetUserId: "target-user-watchlist",
				status: "escalated",
				heuristicScore: 95,
				concordance: "High",
				behavioralFamilies: "[]",
				evidenceMessageId: null,
				krillProbability: null,
				krillBrief: null,
				krillModel: null,
				reviewMessageId: "existing-watchlist-card-msg",
				reviewChannelId: reviewConfig.reviewChannelId,
				deliveryStatus: "delivered",
				cardRevision: 2,
				syncedCardRevision: 2,
				expiresAt: null,
				decidedById: null,
				decisionReason: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			}

			spyOn(reviewData, "claimReviewCaseDelivery").mockResolvedValue(watchlistReEscalatedCase)
			spyOn(reviewData, "updateReviewCase").mockResolvedValue(null as any)

			const mockClient = {
				rest: {
					patch: async (route: string) => {
						patchCalled = true
						patchedMessageId = route
						return {}
					},
					post: async () => {
						postCalled = true
						return { id: "unexpected-post" }
					}
				}
			} as unknown as any

			await postReviewEscalationCard(mockClient, watchlistReEscalatedCase, null, null)
			expect(patchCalled).toBe(true)
			expect(patchedMessageId).toContain("existing-watchlist-card-msg")
			expect(postCalled).toBe(false)
		})

		it("recovers shared cards with failed synchronization during maintenance", async () => {
			let patchCalled = false

			const outOfSyncCase: ReviewCase = {
				id: 3,
				caseId: "case-out-of-sync",
				guildId: reviewConfig.guildId,
				targetUserId: "target-user-sync",
				status: "dismissed",
				heuristicScore: 40,
				concordance: "Low",
				behavioralFamilies: "[]",
				evidenceMessageId: null,
				krillProbability: null,
				krillBrief: null,
				krillModel: null,
				reviewMessageId: "shared-card-msg-1",
				reviewChannelId: reviewConfig.reviewChannelId,
				deliveryStatus: "delivered",
				cardRevision: 3,
				syncedCardRevision: 2,
				expiresAt: null,
				decidedById: "staff-42",
				decisionReason: "False positive",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			}

			spyOn(reviewData, "listOutOfSyncCases").mockResolvedValue([outOfSyncCase])
			let updatedSyncedRevision: number | undefined
			spyOn(reviewData, "updateReviewCase").mockImplementation(async (caseId, update) => {
				if (update.syncedCardRevision !== undefined) {
					updatedSyncedRevision = update.syncedCardRevision
				}
				return null
			})

			const mockClient = {
				rest: {
					patch: async () => {
						patchCalled = true
						return {}
					}
				}
			} as unknown as any

			await recoverSharedCardSync(mockClient)
			expect(patchCalled).toBe(true)
			expect(updatedSyncedRevision).toBe(4) // incremented cardRevision synced
		})

		it("aborts delivery immediately if case is no longer escalated", async () => {
			let postCalled = false
			spyOn(reviewData, "claimReviewCaseDelivery").mockResolvedValue(null)

			const mockClient = {
				rest: {
					post: async () => {
						postCalled = true
						return { id: "should-not-post" }
					}
				}
			} as unknown as any

			const dismissedCase: ReviewCase = {
				id: 5,
				caseId: "case-dismissed",
				guildId: reviewConfig.guildId,
				targetUserId: "u1",
				status: "dismissed",
				heuristicScore: 50,
				concordance: "Low",
				behavioralFamilies: "[]",
				evidenceMessageId: null,
				krillProbability: null,
				krillBrief: null,
				krillModel: null,
				reviewMessageId: null,
				reviewChannelId: null,
				deliveryStatus: "pending",
				expiresAt: null,
				decidedById: "staff-1",
				decisionReason: "Marked human",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			}

			await postReviewEscalationCard(mockClient, dismissedCase, null, null)
			expect(postCalled).toBe(false)
		})
	})

	describe("Database Upgrade & Migration Compatibility", () => {
		it("upgrades a populated existing database from 0012 to 0013 without data loss", () => {
			const db = new Database(":memory:")

			// Read and apply migrations 0000 through 0012
			const drizzleDir = path.join(__dirname, "../drizzle")
			const files = fs
				.readdirSync(drizzleDir)
				.filter((f) => f.endsWith(".sql"))
				.sort()
			const priorMigrations = files.filter((f) => f < "0013")
			const migration13 = files.find((f) => f.startsWith("0013"))!

			for (const file of priorMigrations) {
				const sql = fs.readFileSync(path.join(drizzleDir, file), "utf-8")
				const statements = sql.split("--> statement-breakpoint")
				for (const stmt of statements) {
					const clean = stmt.trim()
					if (clean) db.run(clean)
				}
			}

			// Insert sample rows into existing tables
			db.run(
				"INSERT INTO keyValue (key, value, createdAt, updatedAt) VALUES ('test-key', 'test-value', 1000, 1000)"
			)

			// Apply 0013_reflective_rictor.sql
			const migration13Sql = fs.readFileSync(
				path.join(drizzleDir, migration13),
				"utf-8"
			)
			const statements13 = migration13Sql.split("--> statement-breakpoint")
			for (const stmt of statements13) {
				const clean = stmt.trim()
				if (clean) db.run(clean)
			}

			// Verify existing data is preserved
			const kv = db
				.query("SELECT * FROM keyValue WHERE key = 'test-key'")
				.get() as any
			expect(kv).toBeDefined()
			expect(kv.value).toBe("test-value")

			// Verify new tables are ready and operational
			db.run(
				"INSERT INTO review_cases (case_id, guild_id, target_user_id, status, heuristic_score, concordance, behavioral_families) VALUES ('c1', 'g1', 'u1', 'open', 50, 'High', '[]')"
			)
			const reviewCase = db
				.query("SELECT * FROM review_cases WHERE case_id = 'c1'")
				.get() as any
			expect(reviewCase).toBeDefined()
			expect(reviewCase.status).toBe("open")
			expect(reviewCase.delivery_status).toBe("pending")

			db.close()
		})
	})
})
