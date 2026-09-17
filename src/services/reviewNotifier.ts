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

const findExistingReviewCard = async (
	client: Client,
	channelId: string,
	targetUserId: string
): Promise<string | null> => {
	const botId = process.env.DISCORD_CLIENT_ID
	try {
		const messages = (await client.rest.get(
			Routes.channelMessages(channelId),
			{ limit: 50 }
		)) as any[]
		if (!Array.isArray(messages)) return null
		for (const message of messages) {
			if (message.author?.id === botId || message.author?.bot) {
				const contentStr = JSON.stringify(message.components ?? [])
				if (
					contentStr.includes(targetUserId) &&
					contentStr.includes("Claw & Order")
				) {
					return message.id
				}
			}
		}
	} catch (error) {
		console.warn("Failed to check existing channel messages:", error)
	}
	return null
}

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

	// Atomically claim delivery, ensuring the case is currently escalated and eligible
	const claimedCase = await claimReviewCaseDelivery(reviewCase.caseId)
	if (!claimedCase || claimedCase.status !== "escalated") {
		return
	}

	const channelId = reviewConfig.reviewChannelId

	// Reconcile uncertain or stale delivery before attempting another POST
	const existingMessageId =
		claimedCase.reviewMessageId ||
		(await findExistingReviewCard(client, channelId, claimedCase.targetUserId))

	if (existingMessageId) {
		await updateReviewCase(claimedCase.caseId, {
			reviewMessageId: existingMessageId,
			reviewChannelId: channelId,
			deliveryStatus: "delivered"
		})
		return
	}

	try {
		// Use fresh claimedCase state for rendering
		const container = buildReviewCardContainer(claimedCase, report, krill, false)
		const payload = serializePayload({
			components: [container],
			allowedMentions: { parse: [] }
		})

		const sent = (await client.rest.post(Routes.channelMessages(channelId), {
			body: payload
		})) as { id: string }

		if (sent?.id) {
			try {
				await updateReviewCase(claimedCase.caseId, {
					reviewMessageId: sent.id,
					reviewChannelId: channelId,
					deliveryStatus: "delivered"
				})
			} catch (dbError) {
				console.error("D1 receipt write failed after Discord send:", dbError)
				// Preserve uncertain status so recovery reconciles rather than resending
				await updateReviewCase(claimedCase.caseId, {
					reviewMessageId: sent.id,
					reviewChannelId: channelId,
					deliveryStatus: "uncertain"
				}).catch(() => null)
			}
		} else {
			await updateReviewCase(claimedCase.caseId, {
				deliveryStatus: "uncertain"
			})
		}
	} catch (error) {
		const status =
			error && typeof error === "object" && "status" in error
				? (error as any).status
				: null
		// Only an explicit 4xx rejection proves Discord rejected the message
		const rejected =
			typeof status === "number" && status >= 400 && status < 500 && status !== 408
		console.error("Failed to post review escalation card to Discord:", error)
		await updateReviewCase(claimedCase.caseId, {
			deliveryStatus: rejected ? "failed" : "uncertain"
		})
	}
}

export async function syncSharedReviewCard(
	client: Client,
	reviewCase: ReviewCase
) {
	if (!reviewCase.reviewChannelId || !reviewCase.reviewMessageId) {
		return
	}
	try {
		const container = buildReviewCardContainer(reviewCase, null, null, true)
		await client.rest.patch(
			Routes.channelMessage(
				reviewCase.reviewChannelId,
				reviewCase.reviewMessageId
			),
			{
				body: serializePayload({
					components: [container],
					allowedMentions: { parse: [] }
				})
			}
		)
	} catch (error) {
		console.warn("Failed to synchronize shared review card:", error)
	}
}

export async function recoverReviewEscalations(client: Client) {
	const pending = await getUndeliveredEscalations(reviewConfig.guildId, 5)
	for (const reviewCase of pending) {
		await postReviewEscalationCard(client, reviewCase)
	}
}
