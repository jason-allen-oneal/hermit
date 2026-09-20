import { type Client, Routes, serializePayload } from "@buape/carbon"
import { reviewConfig } from "../config/review.js"
import {
	allocateReescalationRevision,
	attachReviewCaseReceipt,
	beginReviewCardWrite,
	claimOutstandingReviewCardWrite,
	claimReviewReceiptReconciliation,
	clearDeletedReviewReceipt,
	completeReviewCaseDelivery,
	completeReviewCardWrite,
	deferClaimedReviewDeliveryReceipt,
	deferReviewCardSync,
	deferOutstandingReviewCardWrite,
	deferReviewReceiptReconciliation,
	listOutstandingReviewReceipts,
	listOutstandingReviewCardWrites,
	claimReviewCaseDelivery,
	getReviewCase,
	getUndeliveredEscalations,
	listOutOfSyncCases,
	markReviewCardStaleWrite,
	markReviewCardSynced,
	markReviewPostAttemptStarted,
	releaseUnattemptedReviewDelivery,
	reconcileOutstandingReviewCardWrite,
	type ReviewReceiptOwner
} from "../data/review.js"
import type { ReviewCase } from "../db/schema.js"
import { buildReviewCardContainer } from "../components/reviewButtons.js"

type FindCardResult =
	| { status: "found"; messageId: string }
	| { status: "not_found" }
	| { status: "inconclusive"; continuationBefore?: string }

const reviewButtonCaseId = (customId: string): string | null => {
	const colon = customId.indexOf(":")
	if (colon < 0) return null
	const key = customId.slice(0, colon)
	if (!["review-dismiss", "review-watchlist", "review-confirm-bot"].includes(key)) {
		return null
	}
	const pairs = customId.slice(colon + 1).split(";")
	for (const pair of pairs) {
		const [name, value] = pair.split("=", 2)
		if (name === "caseId" && value) return value
	}
	return null
}

const hasLegacyReviewButton = (value: unknown, caseId: string): boolean => {
	if (Array.isArray(value)) return value.some((item) => hasLegacyReviewButton(item, caseId))
	if (!value || typeof value !== "object") return false
	const component = value as { custom_id?: unknown; components?: unknown }
	if (typeof component.custom_id === "string" && reviewButtonCaseId(component.custom_id) === caseId) {
		return true
	}
	return hasLegacyReviewButton(component.components, caseId)
}

const hasReviewIdentity = (value: unknown, caseId: string): boolean => {
	if (!Array.isArray(value)) return false
	const expectedMarker = `-# hermit-review:v1:${caseId}`
	for (const root of value) {
		if (!root || typeof root !== "object") continue
		const container = root as { type?: unknown; components?: unknown }
		if (container.type !== 17 || !Array.isArray(container.components)) continue
		const hasHeader = container.components.some((item) => {
			if (!item || typeof item !== "object") return false
			const component = item as { type?: unknown; content?: unknown }
			return component.type === 10 && component.content === "### 🦞 Claw & Order | Automation Review"
		})
		if (!hasHeader) continue
		const hasMarker = container.components.some((item) => {
			if (!item || typeof item !== "object") return false
			const component = item as { type?: unknown; content?: unknown }
			return component.type === 10 && component.content === expectedMarker
		})
		if (hasMarker || hasLegacyReviewButton(container.components, caseId)) return true
	}
	return false
}

const isReviewReceipt = (
	message: unknown,
	channelId: string,
	caseId: string
): message is { id: string } => {
	if (!message || typeof message !== "object") return false
	const candidate = message as {
		id?: unknown; channel_id?: unknown; components?: unknown
		author?: { id?: unknown; bot?: unknown }
	}
	const botId = process.env.DISCORD_CLIENT_ID
	return Boolean(botId) &&
		candidate.author?.id === botId && candidate.author?.bot === true &&
		typeof candidate.id === "string" && candidate.id.length > 0 &&
		candidate.channel_id === channelId &&
		hasReviewIdentity(candidate.components, caseId)
}

const findExistingReviewCard = async (
	client: Client,
	channelId: string,
	caseId: string,
	_targetUserId: string,
	startingBefore?: string | null
): Promise<FindCardResult> => {
	if (!process.env.DISCORD_CLIENT_ID || channelId !== reviewConfig.reviewChannelId) {
		return { status: "inconclusive", ...(startingBefore ? { continuationBefore: startingBefore } : {}) }
	}
	let before = startingBefore ?? undefined
	try {
		// Bounded lookup. Exhausting the budget is not proof a send failed.
		for (let page = 0; page < 5; page++) {
			const messages = await client.rest.get(Routes.channelMessages(channelId), {
				limit: 50,
				...(before ? { before } : {})
			}) as unknown
			if (!Array.isArray(messages)) {
				return { status: "inconclusive", ...(before ? { continuationBefore: before } : {}) }
			}
			for (const message of messages) {
				if (isReviewReceipt(message, channelId, caseId)) {
					return { status: "found", messageId: message.id }
				}
			}
			if (messages.length < 50) return { status: "not_found" }
			const lastId = messages[messages.length - 1]?.id
			if (typeof lastId !== "string" || !lastId || lastId === before) {
				return { status: "inconclusive", ...(before ? { continuationBefore: before } : {}) }
			}
			before = lastId
		}
		return { status: "inconclusive", ...(before ? { continuationBefore: before } : {}) }
	} catch (error) {
		console.warn("Failed to check existing channel messages:", error)
		return { status: "inconclusive", ...(before ? { continuationBefore: before } : {}) }
	}
}

const attachAndSyncReviewReceipt = async (
	client: Client,
	snapshot: ReviewCase,
	channelId: string,
	messageId: string,
	owner: ReviewReceiptOwner
): Promise<boolean> => {
	const current = await getReviewCase(snapshot.caseId)
	if (!current || current.guildId !== reviewConfig.guildId) return false
	if ((current.reviewMessageId && current.reviewMessageId !== messageId) ||
		(current.reviewChannelId && current.reviewChannelId !== channelId)) {
		throw new Error(`Conflicting review receipt for ${snapshot.caseId}`)
	}
	if (current.deliveryStatus === "delivered" && current.reviewMessageId === messageId) {
		return syncSharedReviewCard(client, current)
	}
	const attached = await attachReviewCaseReceipt(current, channelId, messageId, owner)
	if (attached) return syncSharedReviewCard(client, attached)
	const reloaded = await getReviewCase(snapshot.caseId)
	if (reloaded?.deliveryStatus === "delivered" &&
		reloaded.reviewMessageId === messageId && reloaded.reviewChannelId === channelId) {
		return syncSharedReviewCard(client, reloaded)
	}
	return false
}

const buildSharedReviewPayload = (reviewCase: ReviewCase) =>
	serializePayload({
		components: [
			buildReviewCardContainer(reviewCase, reviewCase.status !== "escalated")
		],
		allowedMentions: { parse: [] }
	})

export async function postReviewEscalationCard(
	client: Client,
	reviewCase: ReviewCase
) {
	if (reviewCase.guildId !== reviewConfig.guildId) {
		return
	}

	const claimedCase = await claimReviewCaseDelivery(
		reviewCase.caseId,
		reviewConfig.guildId
	)
	if (!claimedCase || claimedCase.guildId !== reviewConfig.guildId ||
		claimedCase.status !== "escalated" ||
		!claimedCase.deliveryClaimToken || !claimedCase.deliveryNonce) {
		return
	}

	const channelId = reviewConfig.reviewChannelId
	const deliveryToken = claimedCase.deliveryClaimToken
	const deliveryOwner = { kind: "delivery", token: deliveryToken } as const

	if (claimedCase.reviewMessageId) {
		const allocated = await allocateReescalationRevision(claimedCase.caseId, deliveryToken)
		if (!allocated || allocated.status !== "escalated") {
			return
		}

		const payload = buildSharedReviewPayload(allocated)

		try {
			await client.rest.patch(
				Routes.channelMessage(channelId, allocated.reviewMessageId!),
				{ body: payload }
			)
			const synced = await markReviewCardSynced(
				allocated.caseId,
				allocated.cardRevision
			)
			if (!synced) {
				await markReviewCardStaleWrite(allocated.caseId, allocated.cardRevision)
				await syncSharedReviewCard(client, allocated)
			}
			const completed = await completeReviewCaseDelivery(
				allocated.caseId,
				deliveryToken,
				"delivered"
			)
			if (!completed) {
				const current = await getReviewCase(allocated.caseId)
				if (current?.deliveryStatus !== "delivered" ||
					current.reviewMessageId !== allocated.reviewMessageId) {
					throw new Error(`Lost delivery ownership while refreshing ${allocated.caseId}`)
				}
			}
			return
		} catch (patchError: any) {
			if (patchError?.status === 404) {
				// A confirmed deletion starts a new logical create generation. The
				// guarded mutation rotates its nonce before any later replacement POST.
				await clearDeletedReviewReceipt(allocated, deliveryOwner)
				return
			}
			console.warn("[ReviewNotifier] Failed to refresh existing card:", patchError)
			const repairs = await Promise.allSettled([
				markReviewCardStaleWrite(allocated.caseId, allocated.cardRevision),
				completeReviewCaseDelivery(allocated.caseId, deliveryToken, "delivered")
			])
			const failures = repairs.filter((result) => result.status === "rejected")
			if (failures.length > 0) {
				throw new AggregateError(
					failures.map((result) => result.reason),
					"Failed to persist existing-card recovery work"
				)
			}
			if (repairs[1]?.status === "fulfilled" && repairs[1].value === null) {
				const current = await getReviewCase(allocated.caseId)
				if (current?.deliveryStatus !== "delivered" ||
					current.reviewMessageId !== allocated.reviewMessageId) {
					throw new Error(`Failed to finalize known receipt for ${allocated.caseId}`)
				}
			}
			return
		}
	}

	if (!claimedCase.deliveryPreflightCompletedAt) {
		const existingCheck = await findExistingReviewCard(
			client,
			channelId,
			claimedCase.caseId,
			claimedCase.targetUserId
		)
		if (existingCheck.status === "found") {
			await attachAndSyncReviewReceipt(
				client,
				claimedCase,
				channelId,
				existingCheck.messageId,
				deliveryOwner
			)
			return
		}
		if (existingCheck.status === "inconclusive") {
			await deferClaimedReviewDeliveryReceipt(
				claimedCase.caseId,
				deliveryToken,
				existingCheck.continuationBefore ?? null
			)
			return
		}
	}

	const attemptedCase = await markReviewPostAttemptStarted(
		claimedCase.caseId,
		deliveryToken
	)
	if (!attemptedCase) {
		await completeReviewCaseDelivery(claimedCase.caseId, deliveryToken, "failed")
		return
	}

	const payload = buildSharedReviewPayload(attemptedCase)
	let sent: { id?: string }
	try {
		sent = (await client.rest.post(Routes.channelMessages(channelId), {
			body: {
				...payload,
				nonce: attemptedCase.deliveryNonce,
				enforce_nonce: true
			}
		})) as { id?: string }
	} catch (error) {
		const status =
			error && typeof error === "object" && "status" in error
				? (error as any).status
				: null
		// Only an explicit 4xx rejection proves Discord rejected the message
		const rejected =
			typeof status === "number" && status >= 400 && status < 500 && status !== 408
		console.error("Failed to post review escalation card to Discord:", error)
		if (rejected) {
			await completeReviewCaseDelivery(claimedCase.caseId, deliveryToken, "failed")
		} else {
			await deferClaimedReviewDeliveryReceipt(claimedCase.caseId, deliveryToken, null)
		}
		return
	}

	if (!sent.id) {
		await deferClaimedReviewDeliveryReceipt(claimedCase.caseId, deliveryToken, null)
		return
	}
	await attachAndSyncReviewReceipt(client, attemptedCase, channelId, sent.id, deliveryOwner)
}

export async function syncSharedReviewCard(
	client: Client,
	reviewCase: ReviewCase
): Promise<boolean> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const fresh = await getReviewCase(reviewCase.caseId)
		if (!fresh || fresh.guildId !== reviewConfig.guildId ||
			!fresh.reviewMessageId ||
			fresh.reviewChannelId !== reviewConfig.reviewChannelId) return false
		if (fresh.cardRevision <= fresh.syncedCardRevision) return true

		const renderedRevision = fresh.cardRevision
		const writeAttemptToken = crypto.randomUUID()
		await beginReviewCardWrite(fresh, renderedRevision, writeAttemptToken)
		try {
			await client.rest.patch(
				Routes.channelMessage(fresh.reviewChannelId, fresh.reviewMessageId),
				{ body: buildSharedReviewPayload(fresh) }
			)
			const synced = await markReviewCardSynced(fresh.caseId, renderedRevision)
			if (synced) {
				if (!await completeReviewCardWrite(writeAttemptToken)) {
					throw new Error(`Failed to close shared-card write attempt for ${fresh.caseId}`)
				}
				return true
			}
			await markReviewCardStaleWrite(fresh.caseId, renderedRevision)
		} catch (error) {
			console.warn("Failed to synchronize shared review card:", error)
			if (error && typeof error === "object" && "status" in error &&
				(error as { status?: unknown }).status === 404) {
				const cleared = await clearDeletedReviewReceipt(fresh)
				if (cleared) return false
				const current = await getReviewCase(fresh.caseId)
				if (current?.reviewMessageId !== fresh.reviewMessageId ||
					current?.reviewChannelId !== fresh.reviewChannelId) {
					continue
				}
				throw new Error(`Failed to clear confirmed-deleted card ${fresh.caseId}`)
			}
			const repairs = await Promise.allSettled([
				markReviewCardStaleWrite(fresh.caseId, renderedRevision),
				deferReviewCardSync(fresh.caseId)
			])
			const failures = repairs.filter((result) => result.status === "rejected")
			if (failures.length > 0) {
				throw new AggregateError(
					failures.map((result) => result.reason),
					"Failed to persist ambiguous shared-card repair"
				)
			}
			const current = await getReviewCase(fresh.caseId)
			if (!current || current.cardRevision <= current.syncedCardRevision) {
				throw new Error(`Ambiguous shared-card write for ${fresh.caseId} was not left dirty`)
			}
			return false
		}
	}
	const deferred = await deferReviewCardSync(reviewCase.caseId)
	if (!deferred) {
		const current = await getReviewCase(reviewCase.caseId)
		if (!current || current.cardRevision <= current.syncedCardRevision) {
			throw new Error(`Shared-card retry budget for ${reviewCase.caseId} exhausted without dirty work`)
		}
	}
	return false
}

export async function recoverOutstandingReviewCardWrites(client: Client) {
	const outstanding = await listOutstandingReviewCardWrites(reviewConfig.guildId, 10)
	for (const candidate of outstanding) {
		const claimToken = crypto.randomUUID()
		const attempt = await claimOutstandingReviewCardWrite(candidate.attemptToken, claimToken)
		if (!attempt) continue
		try {
			const reviewCase = await reconcileOutstandingReviewCardWrite(attempt, claimToken)
			if (!reviewCase) {
				if (!await completeReviewCardWrite(attempt.attemptToken)) {
					throw new Error(`Could not retire obsolete shared-card write ${attempt.attemptToken}`)
				}
				continue
			}
			await syncSharedReviewCard(client, reviewCase)
		} catch (error) {
			console.error(`Outstanding card-write recovery failed for ${attempt.caseId}:`, error)
			await deferOutstandingReviewCardWrite(attempt.attemptToken, claimToken).catch(
				(persistenceError) => console.error("Failed to persist card-write backoff:", persistenceError)
			)
		}
	}
}

export async function recoverReviewReceipts(client: Client) {
	const outstanding = await listOutstandingReviewReceipts(reviewConfig.guildId, 10)
	for (const candidate of outstanding) {
		const claimToken = crypto.randomUUID()
		const reviewCase = await claimReviewReceiptReconciliation(
			candidate.caseId,
			reviewConfig.guildId,
			claimToken
		)
		if (!reviewCase) continue
		try {
			if (reviewCase.guildId !== reviewConfig.guildId) continue
			if (reviewCase.reviewChannelId &&
				reviewCase.reviewChannelId !== reviewConfig.reviewChannelId) {
				throw new Error(`Review receipt channel conflict for ${reviewCase.caseId}`)
			}
			const channelId = reviewConfig.reviewChannelId
			let result: FindCardResult
			if (reviewCase.reviewMessageId) {
				const message = await client.rest.get(
					Routes.channelMessage(channelId, reviewCase.reviewMessageId)
				)
				result = isReviewReceipt(message, channelId, reviewCase.caseId) &&
					message.id === reviewCase.reviewMessageId
					? { status: "found", messageId: message.id }
					: { status: "inconclusive" }
			} else {
				result = await findExistingReviewCard(
					client,
					channelId,
					reviewCase.caseId,
					reviewCase.targetUserId,
					reviewCase.receiptHistoryBefore
				)
			}
			if (result.status === "found") {
				await attachAndSyncReviewReceipt(
					client,
					reviewCase,
					channelId,
					result.messageId,
					{ kind: "receipt", token: claimToken }
				)
			} else if (result.status === "not_found" &&
				!reviewCase.reviewMessageId &&
				reviewCase.deliveryAttemptState === "unattempted") {
				// A complete history scan proved there is no receipt, and the durable
				// pre-I/O fact proves this delivery generation never reached POST.
				// Release it for the later new-send stage without manufacturing an
				// uncertain outcome or repeating the bounded history scan.
				const released = await releaseUnattemptedReviewDelivery(reviewCase, claimToken)
				if (!released) {
					const current = await getReviewCase(reviewCase.caseId)
					if (current?.deliveryStatus !== "delivered") {
						throw new Error(`Lost unattempted-delivery ownership for ${reviewCase.caseId}`)
					}
				}
			} else {
				const deferred = await deferReviewReceiptReconciliation(
					reviewCase,
					claimToken,
					result.status === "inconclusive" ? result.continuationBefore ?? null : null
				)
				if (!deferred) {
					const current = await getReviewCase(reviewCase.caseId)
					if (current?.deliveryStatus !== "delivered") {
						throw new Error(`Lost receipt-reconciliation ownership for ${reviewCase.caseId}`)
					}
				}
				console.warn(`[ReviewNotifier] Receipt for ${reviewCase.caseId} remains unresolved (${result.status})`)
			}
		} catch (error) {
			console.error(`[ReviewNotifier] Receipt recovery failed for ${reviewCase.caseId}:`, error)
			try {
				if (error && typeof error === "object" && "status" in error &&
					(error as { status?: unknown }).status === 404 && reviewCase.reviewMessageId) {
					const cleared = await clearDeletedReviewReceipt(
						reviewCase,
						{ kind: "receipt", token: claimToken }
					)
					if (cleared) continue
					const current = await getReviewCase(reviewCase.caseId)
					if (current?.reviewMessageId !== reviewCase.reviewMessageId ||
						current?.reviewChannelId !== reviewCase.reviewChannelId) {
						continue
					}
				}
				const deferred = await deferReviewReceiptReconciliation(
					reviewCase,
					claimToken,
					reviewCase.receiptHistoryBefore
				)
				if (!deferred) {
					const current = await getReviewCase(reviewCase.caseId)
					if (current?.deliveryStatus !== "delivered") {
						console.error(`Receipt recovery lease was lost for ${reviewCase.caseId}`)
					}
				}
			} catch (persistenceError) {
				console.error("Failed to persist receipt recovery backoff:", persistenceError)
			}
		}
	}
}

export async function recoverSharedCardSync(client: Client) {
	const outOfSync = await listOutOfSyncCases(
		reviewConfig.guildId,
		reviewConfig.reviewChannelId,
		10
	)
	for (const reviewCase of outOfSync) {
		try {
			await syncSharedReviewCard(client, reviewCase)
		} catch (error) {
			console.error(`Shared card recovery failed for ${reviewCase.caseId}:`, error)
		}
	}
}

export async function recoverReviewEscalations(client: Client) {
	const pending = await getUndeliveredEscalations(reviewConfig.guildId, 5)
	for (const reviewCase of pending) {
		try {
			await postReviewEscalationCard(client, reviewCase)
		} catch (error) {
			console.error(`Escalation recovery failed for ${reviewCase.caseId}:`, error)
		}
	}
}
