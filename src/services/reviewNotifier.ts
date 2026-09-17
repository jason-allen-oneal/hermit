import { type Client, Routes, serializePayload } from "@buape/carbon"
import { reviewConfig } from "../config/review.js"
import { updateReviewCase } from "../data/review.js"
import type { ReviewCase } from "../db/schema.js"
import type { AnalysisReport, KrillEvaluation } from "../review/types.js"
import { buildReviewCardContainer } from "../components/reviewButtons.js"

export async function postReviewEscalationCard(
	client: Client,
	reviewCase: ReviewCase,
	report: AnalysisReport,
	krill?: KrillEvaluation | null
) {
	try {
		const channelId = reviewConfig.reviewChannelId
		const container = buildReviewCardContainer(reviewCase, report, krill, false)
		const payload = serializePayload({
			components: [container],
			allowedMentions: { parse: [] }
		})

		const sent = (await client.rest.post(Routes.channelMessages(channelId), {
			body: payload
		})) as { id: string }

		if (sent?.id) {
			await updateReviewCase(reviewCase.caseId, {
				reviewMessageId: sent.id,
				reviewChannelId: channelId
			})
		}
	} catch (error) {
		console.error("Failed to post review escalation card to Discord:", error)
	}
}
