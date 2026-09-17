import { type Client, Routes, serializePayload } from "@buape/carbon"
import { reviewConfig } from "../config/review.js"
import {
	claimReviewCaseDelivery,
	getUndeliveredEscalations,
	updateReviewCase
} from "../data/review.js"
import type { ReviewCase } from "../db/schema.js"
import type { AnalysisReport, KrillEvaluation } from "../review/types.js"
import { buildReviewCardContainer } from "../components/reviewButtons.js"

export async function postReviewEscalationCard(
	client: Client,
	reviewCase: ReviewCase,
	report?: AnalysisReport | null,
	krill?: KrillEvaluation | null
) {
	// Strictly enforce guild boundary
	if (reviewCase.guildId !== reviewConfig.guildId) {
		return
	}

	// Atomically claim delivery to prevent duplicate cards under concurrent events
	const claimed = await claimReviewCaseDelivery(reviewCase.caseId)
	if (!claimed) {
		return
	}

	const channelId = reviewConfig.reviewChannelId
	try {
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
				reviewChannelId: channelId,
				deliveryStatus: "delivered"
			})
		} else {
			await updateReviewCase(reviewCase.caseId, {
				deliveryStatus: "failed"
			})
		}
	} catch (error) {
		console.error("Failed to post review escalation card to Discord:", error)
		await updateReviewCase(reviewCase.caseId, {
			deliveryStatus: "failed"
		})
	}
}

export async function recoverReviewEscalations(client: Client) {
	const pending = await getUndeliveredEscalations(reviewConfig.guildId, 5)
	for (const reviewCase of pending) {
		await postReviewEscalationCard(client, reviewCase)
	}
}
