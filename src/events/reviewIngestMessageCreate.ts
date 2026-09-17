import {
	type Client,
	type ListenerEventData,
	MessageCreateListener
} from "@buape/carbon"
import { reviewConfig } from "../config/review.js"
import { recordObservation, getRecentUserObservations, createReviewCase, getReviewCase } from "../data/review.js"
import { contentFeatures } from "../review/features.js"
import { analyze } from "../review/analyzer.js"
import { evaluateWithKrill } from "../review/krillEvaluator.js"
import { postReviewEscalationCard } from "../services/reviewNotifier.js"

const getSecretKey = () =>
	process.env.DEPLOY_SECRET || "hermit-review-salt-key-minimum-32-chars-length-padding"

export default class ReviewIngestMessageCreate extends MessageCreateListener {
	async handle(data: ListenerEventData[this["type"]], client: Client) {
		if (!data.guild_id || !data.channel_id || data.webhook_id) {
			return
		}
		if (!data.content && (!data.attachments || data.attachments.length === 0)) {
			return
		}

		const secret = getSecretKey()
		const features = contentFeatures(
			data.content || "",
			secret,
			data.guild_id,
			data.author.id,
			{
				hasMedia: Boolean(data.attachments && data.attachments.length > 0)
			}
		)

		// Get replyToId if message is a reply
		const replyToId = data.message_reference?.message_id || null

		try {
			await recordObservation({
				messageId: data.id,
				guildId: data.guild_id,
				channelId: data.channel_id,
				authorId: data.author.id,
				createdAt: data.timestamp || new Date().toISOString(),
				replyToId,
				contentLength: features.contentLength,
				lineCount: features.lineCount,
				fingerprint: features.fingerprint,
				artifacts: JSON.stringify(features.artifacts)
			})

			// If strong operational/thought markers appear, check if account meets escalation threshold
			const hasCriticalMarker =
				features.artifacts.includes("execution-marker") ||
				features.artifacts.includes("tool-envelope")

			if (hasCriticalMarker) {
				const recent = await getRecentUserObservations(
					data.guild_id,
					data.author.id,
					reviewConfig.windowDays,
					reviewConfig.maxObservationsPerSample
				)

				if (recent.length >= 10) {
					const now = Date.now()
					const windowStart = now - reviewConfig.windowDays * 86400000
					const report = analyze({
						guildId: data.guild_id,
						authorId: data.author.id,
						startAt: windowStart,
						endAt: now,
						messages: recent,
						scoreGate: { minMessages: 10, minSpanMs: 60000 }
					})

					if (report.priority === "review-recommended") {
						const caseId = `case-${data.guild_id}-${data.author.id}`
						const existing = await getReviewCase(caseId)
						if (!existing || existing.status === "open") {
							// Evaluate with Krill (gpt-6-astra low-thinking)
							const krill = await evaluateWithKrill(report)

							const createdCase = await createReviewCase({
								caseId,
								guildId: data.guild_id,
								targetUserId: data.author.id,
								status: "escalated",
								heuristicScore: report.heuristicScore ?? 0,
								concordance: report.concordance,
								behavioralFamilies: JSON.stringify(
									Object.keys(report.familyScores)
								),
								evidenceMessageId: data.id,
								krillProbability: krill
									? `${(krill.automationProbability * 100).toFixed(1)}%`
									: null,
								krillBrief: krill?.brief ?? null,
								krillModel: krill?.model ?? null,
								reviewChannelId: reviewConfig.reviewChannelId
							})

							if (createdCase) {
								await postReviewEscalationCard(client, createdCase, report, krill)
							}
						}
					}
				}
			}
		} catch (error) {
			console.error("Error in ReviewIngestMessageCreate:", error)
		}
	}
}
