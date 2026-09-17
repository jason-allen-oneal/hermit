import { type Client, Routes, serializePayload } from "@buape/carbon"
import { reviewConfig } from "../config/review.js"
import {
	claimReviewCaseDelivery,
	getReviewCase,
	getUndeliveredEscalations,
	listOutOfSyncCases,
	updateReviewCase
} from "../data/review.js"
import type { ReviewCase } from "../db/schema.js"
import type { AnalysisReport, KrillEvaluation } from "../review/types.js"
import { buildReviewCardContainer } from "../components/reviewButtons.js"

type FindCardResult =
	| { status: "found"; messageId: string }
	| { status: "not_found" }
	| { status: "inconclusive" }

const findExistingReviewCard = async (
	client: Client,
	channelId: string,
	caseId: string,
	targetUserId: string
): Promise<FindCardResult> => {
	const botId = process.env.DISCORD_CLIENT_ID
	if (!botId) return { status: "inconclusive" }

	try {
		const messages = (await client.rest.get(
			Routes.channelMessages(channelId),
			{ limit: 50 }
		)) as any[]
		if (!Array.isArray(messages)) return { status: "inconclusive" }

		for (const message of messages) {
			// Require EXACT bot identity and bot flag - strictly reject foreign bot messages
			if (message.author?.id === botId && message.author?.bot === true) {
				const contentStr = JSON.stringify(message.components ?? [])
				// Require case-specific marker (caseId in customId or content) AND targetUserId
				if (
					contentStr.includes(`caseId=${caseId}`) ||
					(contentStr.includes(caseId) && contentStr.includes(targetUserId))
				) {
					return { status: "found", messageId: message.id }
				}
			}
		}
		return { status: "not_found" }
	} catch (error) {
		console.warn("Failed to check existing channel messages:", error)
		return { status: "inconclusive" }
	}
}

const generateNonce = async (key: string): Promise<string> => {
	const hashBuffer = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(key)
	)
	return Array.from(new Uint8Array(hashBuffer), (b) =>
		b.toString(16).padStart(2, "0")
	)
		.join("")
		.slice(0, 25)
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

	// If the case already has a reviewMessageId (e.g. watchlist case escalating again),
	// reopen/refresh the existing card with active buttons rather than posting a duplicate
	if (claimedCase.reviewMessageId) {
		const container = buildReviewCardContainer(claimedCase, report, krill, false)
		const payload = serializePayload({
			components: [container],
			allowedMentions: { parse: [] }
		})

		try {
			await client.rest.patch(
				Routes.channelMessage(channelId, claimedCase.reviewMessageId),
				{ body: payload }
			)
			await updateReviewCase(claimedCase.caseId, {
				reviewChannelId: channelId,
				deliveryStatus: "delivered",
				cardRevision: (claimedCase.cardRevision || 1) + 1,
				syncedCardRevision: (claimedCase.cardRevision || 1) + 1
			})
			return
		} catch (patchError: any) {
			if (patchError?.status === 404) {
				// Old card deleted in Discord; clear messageId and proceed to send fresh
				await updateReviewCase(claimedCase.caseId, { reviewMessageId: null })
				claimedCase.reviewMessageId = null
			} else {
				console.warn("[ReviewNotifier] Failed to refresh existing card:", patchError)
				await updateReviewCase(claimedCase.caseId, { deliveryStatus: "uncertain" })
				return
			}
		}
	}

	// If the case is in uncertain state, reconcile against history.
	// Absence from bounded history is NOT permission to resend (avoids duplicates).
	if (claimedCase.deliveryStatus === "uncertain") {
		const lookup = await findExistingReviewCard(
			client,
			channelId,
			claimedCase.caseId,
			claimedCase.targetUserId
		)
		if (lookup.status === "found") {
			await updateReviewCase(claimedCase.caseId, {
				reviewMessageId: lookup.messageId,
				reviewChannelId: channelId,
				deliveryStatus: "delivered"
			})
			return
		}
		// Inconclusive or not found: preserve uncertainty; do not send another POST
		console.warn(
			`[ReviewNotifier] Delivery for case ${claimedCase.caseId} remains uncertain; reconciliation did not find Hermit card`
		)
		return
	}

	// Reconcile before first send
	const existingCheck = await findExistingReviewCard(
		client,
		channelId,
		claimedCase.caseId,
		claimedCase.targetUserId
	)
	if (existingCheck.status === "found") {
		await updateReviewCase(claimedCase.caseId, {
			reviewMessageId: existingCheck.messageId,
			reviewChannelId: channelId,
			deliveryStatus: "delivered"
		})
		return
	}

	// Guard against case revisions made while awaiting channel history
	const freshCase = await getReviewCase(claimedCase.caseId)
	if (freshCase && freshCase.status !== "escalated") {
		// Staff intervened (dismissed/watchlist); abort send immediately
		return
	}
	const caseToRender = freshCase ?? claimedCase

	try {
		// Render with fresh case state
		const container = buildReviewCardContainer(caseToRender, report, krill, false)
		const payload = serializePayload({
			components: [container],
			allowedMentions: { parse: [] }
		})
		const nonce = await generateNonce(
			`review-escalate:${claimedCase.caseId}:${claimedCase.updatedAt}`
		)

		const sent = (await client.rest.post(Routes.channelMessages(channelId), {
			body: {
				...payload,
				nonce,
				enforce_nonce: true
			}
		})) as { id: string }

		if (sent?.id) {
			try {
				await updateReviewCase(claimedCase.caseId, {
					reviewMessageId: sent.id,
					reviewChannelId: channelId,
					deliveryStatus: "delivered"
				})

				// If staff intervened while the POST was in-flight, immediately synchronize the card
				const postSendCase = await getReviewCase(claimedCase.caseId)
				if (postSendCase && postSendCase.status !== "escalated") {
					await syncSharedReviewCard(client, postSendCase)
				}
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
): Promise<boolean> {
	if (!reviewCase.reviewChannelId || !reviewCase.reviewMessageId) {
		return false
	}
	const nextRevision = (reviewCase.cardRevision || 1) + 1
	await updateReviewCase(reviewCase.caseId, {
		cardRevision: nextRevision
	})

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
		await updateReviewCase(reviewCase.caseId, {
			syncedCardRevision: nextRevision
		})
		return true
	} catch (error) {
		console.warn("Failed to synchronize shared review card:", error)
		return false
	}
}

export async function recoverSharedCardSync(client: Client) {
	const outOfSync = await listOutOfSyncCases(10)
	for (const reviewCase of outOfSync) {
		await syncSharedReviewCard(client, reviewCase)
	}
}

export async function recoverReviewEscalations(client: Client) {
	const pending = await getUndeliveredEscalations(reviewConfig.guildId, 5)
	for (const reviewCase of pending) {
		await postReviewEscalationCard(client, reviewCase)
	}
}
