import { and, eq, gte, gt, sql, desc, asc, inArray } from "drizzle-orm"
import { getDb } from "../db.js"
import {
	reviewCases,
	reviewCardWriteAttempts,
	reviewObservations,
	type NewReviewCase,
	type NewReviewObservation,
	type ReviewCase,
	type ReviewCardWriteAttempt,
	type ReviewObservation
} from "../db/schema.js"
import type { ReviewMessage } from "../review/types.js"
import { reviewConfig } from "../config/review.js"
import {
	getRecentDiscrawlObservations,
	getDiscrawlObservationCount,
	fetchRemoteDiscrawlObservations,
	fetchRemoteDiscrawlCount
} from "../services/discrawl.js"

const now = sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

export type ReviewReceiptOwner =
	| { kind: "delivery"; token: string }
	| { kind: "receipt"; token: string }

const receiptOwnerMatches = (owner: ReviewReceiptOwner) =>
	owner.kind === "delivery"
		? eq(reviewCases.deliveryClaimToken, owner.token)
		: eq(reviewCases.receiptClaimToken, owner.token)

export const recordObservation = async (
	observation: NewReviewObservation
): Promise<ReviewObservation | null> => {
	if (reviewConfig.discrawlExportPath || reviewConfig.discrawlExportUrl) {
		return null
	}
	const [record] = await getDb()
		.insert(reviewObservations)
		.values(observation)
		.onConflictDoNothing({ target: [reviewObservations.messageId] })
		.returning()

	return record ?? null
}

export const getRecentUserObservations = async (
	guildId: string,
	authorId: string,
	windowDays = 7,
	limit = 200
): Promise<ReviewMessage[]> => {
	if (reviewConfig.discrawlExportUrl) {
		return fetchRemoteDiscrawlObservations(
			reviewConfig.discrawlExportUrl,
			reviewConfig.discrawlSecret || "",
			guildId,
			authorId,
			windowDays,
			limit
		)
	}
	if (reviewConfig.discrawlExportPath) {
		return getRecentDiscrawlObservations(
			reviewConfig.discrawlExportPath,
			guildId,
			authorId,
			windowDays,
			limit
		)
	}

	const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString()

	const rows = await getDb()
		.select()
		.from(reviewObservations)
		.where(
			and(
				eq(reviewObservations.guildId, guildId),
				eq(reviewObservations.authorId, authorId),
				gte(reviewObservations.createdAt, cutoff)
			)
		)
		.orderBy(desc(reviewObservations.createdAt))
		.limit(limit)

	if (rows.length === 0) {
		return []
	}

	// Fetch reply parent timestamps to compute replyLatencyMs
	const replyIds = rows
		.map((r) => r.replyToId)
		.filter((id): id is string => Boolean(id))

	const parentMap = new Map<string, number>()
	if (replyIds.length > 0) {
		const parents = await getDb()
			.select({
				messageId: reviewObservations.messageId,
				createdAt: reviewObservations.createdAt
			})
			.from(reviewObservations)
			.where(inArray(reviewObservations.messageId, replyIds))

		for (const p of parents) {
			parentMap.set(p.messageId, new Date(p.createdAt).getTime())
		}
	}

	return rows.map((r) => {
		const createdTime = new Date(r.createdAt).getTime()
		let replyLatencyMs: number | null = null
		if (r.replyToId && parentMap.has(r.replyToId)) {
			const parentTime = parentMap.get(r.replyToId)!
			if (createdTime >= parentTime) {
				replyLatencyMs = createdTime - parentTime
			}
		}

		let parsedArtifacts: string[] = []
		try {
			parsedArtifacts = JSON.parse(r.artifacts)
		} catch {
			parsedArtifacts = []
		}

		return {
			...r,
			createdAt: createdTime,
			artifacts: parsedArtifacts as any,
			replyLatencyMs
		}
	})
}

export const createReviewCase = async (
	data: NewReviewCase
): Promise<ReviewCase | null> => {
	const insertData = {
		...data,
		deliveryAttemptState: data.deliveryAttemptState ?? "unattempted"
	}
	const reopening = sql`(review_cases.status = 'open' OR (
		review_cases.status = 'watchlist'
		AND review_cases.expires_at IS NOT NULL
		AND review_cases.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	))`
	const unresolvedDelivery = sql`(
		review_cases.delivery_status IN ('uncertain', 'delivering')
		OR (
			review_cases.delivery_post_attempted_at IS NOT NULL
			AND review_cases.review_message_id IS NULL
		)
	)`
	const [reviewCase] = await getDb()
		.insert(reviewCases)
		.values(insertData)
		.onConflictDoUpdate({
			target: [reviewCases.caseId],
			set: {
				status: sql`CASE 
					WHEN review_cases.status = 'open' THEN ${data.status}
					WHEN review_cases.status = 'watchlist' AND review_cases.expires_at IS NOT NULL AND review_cases.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') THEN ${data.status}
					ELSE review_cases.status 
				END`,
					deliveryStatus: sql`CASE
						WHEN ${reopening} AND ${unresolvedDelivery} THEN review_cases.delivery_status
						WHEN ${reopening} THEN ${data.deliveryStatus ?? "pending"}
						ELSE review_cases.delivery_status
					END`,
					deliveryNonce: sql`CASE
						WHEN ${reopening} AND ${unresolvedDelivery} THEN review_cases.delivery_nonce
						WHEN ${reopening} THEN NULL
						ELSE review_cases.delivery_nonce
					END`,
					deliveryPreflightCompletedAt: sql`CASE
						WHEN ${reopening} AND ${unresolvedDelivery} THEN review_cases.delivery_preflight_completed_at
						WHEN ${reopening} THEN NULL
						ELSE review_cases.delivery_preflight_completed_at
					END`,
					deliveryPostAttemptedAt: sql`CASE
						WHEN ${reopening} AND ${unresolvedDelivery} THEN review_cases.delivery_post_attempted_at
						WHEN ${reopening} THEN NULL
						ELSE review_cases.delivery_post_attempted_at
					END`,
					deliveryAttemptState: sql`CASE
						WHEN ${reopening} AND ${unresolvedDelivery} THEN review_cases.delivery_attempt_state
						WHEN ${reopening} THEN 'unattempted'
						ELSE review_cases.delivery_attempt_state
					END`,
					deliveryClaimToken: sql`CASE
						WHEN ${reopening} AND ${unresolvedDelivery} THEN review_cases.delivery_claim_token
						WHEN ${reopening} THEN NULL
						ELSE review_cases.delivery_claim_token
					END`,
					deliveryClaimExpiresAt: sql`CASE
						WHEN ${reopening} AND ${unresolvedDelivery} THEN review_cases.delivery_claim_expires_at
						WHEN ${reopening} THEN NULL
						ELSE review_cases.delivery_claim_expires_at
					END`,
					receiptClaimToken: sql`CASE
						WHEN ${reopening} AND ${unresolvedDelivery} THEN review_cases.receipt_claim_token
						WHEN ${reopening} THEN NULL
						ELSE review_cases.receipt_claim_token
					END`,
					receiptClaimExpiresAt: sql`CASE
						WHEN ${reopening} AND ${unresolvedDelivery} THEN review_cases.receipt_claim_expires_at
						WHEN ${reopening} THEN NULL
						ELSE review_cases.receipt_claim_expires_at
					END`,
					receiptNextAttemptAt: sql`CASE
						WHEN ${reopening} AND ${unresolvedDelivery} THEN review_cases.receipt_next_attempt_at
						WHEN ${reopening} THEN NULL
						ELSE review_cases.receipt_next_attempt_at
					END`,
					receiptHistoryBefore: sql`CASE
						WHEN ${reopening} AND ${unresolvedDelivery} THEN review_cases.receipt_history_before
						WHEN ${reopening} THEN NULL
						ELSE review_cases.receipt_history_before
					END`,
				heuristicScore: data.heuristicScore,
				concordance: data.concordance,
				behavioralFamilies: data.behavioralFamilies,
				keySignals: data.keySignals,
				evidenceMessageId: data.evidenceMessageId,
				krillProbability: data.krillProbability,
				krillBrief: data.krillBrief,
				krillModel: data.krillModel,
				reviewChannelId: data.reviewChannelId,
				cardRevision: sql`${reviewCases.cardRevision} + 1`,
				cardSyncNextAttemptAt: null,
				cardSyncFailureCount: 0,
				updatedAt: now
			}
		})
		.returning()

	return reviewCase ?? null
}

export const getReviewCase = async (
	caseId: string
): Promise<ReviewCase | null> => {
	const [record] = await getDb()
		.select()
		.from(reviewCases)
		.where(eq(reviewCases.caseId, caseId))
		.limit(1)

	return record ?? null
}

export const updateReviewCase = async (
	caseId: string,
	update: Partial<NewReviewCase>
): Promise<ReviewCase | null> => {
	const [updated] = await getDb()
		.update(reviewCases)
		.set({
			...update,
			updatedAt: now
		})
		.where(eq(reviewCases.caseId, caseId))
		.returning()

	return updated ?? null
}

export const claimReviewCaseDelivery = async (
	caseId: string,
	guildId: string,
	claimTimeoutMs = 120_000
): Promise<ReviewCase | null> => {
	const claimExpiresAt = new Date(Date.now() + claimTimeoutMs).toISOString()
	const [claimed] = await getDb()
		.update(reviewCases)
		.set({
			previousDeliveryStatus: reviewCases.deliveryStatus,
			deliveryStatus: "delivering",
			deliveryNonce: sql`COALESCE(${reviewCases.deliveryNonce}, lower(hex(randomblob(12))))`,
			deliveryClaimToken: sql`lower(hex(randomblob(16)))`,
			deliveryClaimExpiresAt: claimExpiresAt,
			updatedAt: now
		})
		.where(
			and(
				eq(reviewCases.caseId, caseId),
				eq(reviewCases.guildId, guildId),
				eq(reviewCases.status, "escalated"),
				sql`${reviewCases.deliveryStatus} IN ('pending', 'failed')`
			)
		)
		.returning()

	return claimed ?? null
}

export const completeReviewCaseDelivery = async (
	caseId: string,
	claimToken: string,
	deliveryStatus: "delivered" | "uncertain" | "failed"
): Promise<ReviewCase | null> => {
	if (!claimToken) return null
	const [updated] = await getDb()
		.update(reviewCases)
		.set({
			deliveryStatus,
			deliveryPreflightCompletedAt: deliveryStatus === "failed" ? now : null,
			deliveryPostAttemptedAt: null,
			deliveryAttemptState: deliveryStatus === "failed" ? "unattempted" : "attempted",
			deliveryClaimToken: null,
			deliveryClaimExpiresAt: null,
			updatedAt: now
		})
		.where(and(
			eq(reviewCases.caseId, caseId),
			eq(reviewCases.deliveryClaimToken, claimToken)
		))
		.returning()
	return updated ?? null
}

export const deferClaimedReviewDeliveryReceipt = async (
	caseId: string,
	claimToken: string,
	historyBefore: string | null,
	backoffMs = 60_000
): Promise<ReviewCase | null> => {
	if (!claimToken) return null
	const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString()
	const [updated] = await getDb()
		.update(reviewCases)
		.set({
			deliveryStatus: "uncertain",
			deliveryClaimToken: null,
			deliveryClaimExpiresAt: null,
			receiptNextAttemptAt: nextAttemptAt,
			receiptHistoryBefore: historyBefore,
			updatedAt: now
		})
		.where(and(
			eq(reviewCases.caseId, caseId),
			eq(reviewCases.deliveryClaimToken, claimToken)
		))
		.returning()
	return updated ?? null
}

export const markReviewPostAttemptStarted = async (
	caseId: string,
	claimToken: string
): Promise<ReviewCase | null> => {
	if (!claimToken) return null
	const [updated] = await getDb()
		.update(reviewCases)
		.set({
			deliveryPreflightCompletedAt: null,
			deliveryPostAttemptedAt: now,
			deliveryAttemptState: "attempted",
			updatedAt: now
		})
		.where(and(
			eq(reviewCases.caseId, caseId),
			eq(reviewCases.status, "escalated"),
			eq(reviewCases.deliveryStatus, "delivering"),
			eq(reviewCases.deliveryClaimToken, claimToken),
			sql`${reviewCases.deliveryPostAttemptedAt} IS NULL`
		))
		.returning()
	return updated ?? null
}

export const clearDeletedReviewReceipt = async (
	snapshot: ReviewCase,
	owner?: ReviewReceiptOwner
): Promise<ReviewCase | null> => {
	if (!snapshot.reviewMessageId || !snapshot.reviewChannelId || (owner && !owner.token)) return null
	const ownership = owner ? [receiptOwnerMatches(owner)] : []
	const [updated] = await getDb()
		.update(reviewCases)
		.set({
			reviewMessageId: null,
			reviewChannelId: null,
			deliveryStatus: "failed",
			deliveryNonce: sql`lower(hex(randomblob(12)))`,
			deliveryPreflightCompletedAt: null,
			deliveryPostAttemptedAt: null,
			deliveryAttemptState: "unattempted",
			deliveryClaimToken: null,
			deliveryClaimExpiresAt: null,
			receiptClaimToken: null,
			receiptClaimExpiresAt: null,
			receiptNextAttemptAt: null,
			receiptHistoryBefore: null,
			updatedAt: now
		})
		.where(and(
			eq(reviewCases.caseId, snapshot.caseId),
			eq(reviewCases.guildId, snapshot.guildId),
			eq(reviewCases.reviewMessageId, snapshot.reviewMessageId),
			eq(reviewCases.reviewChannelId, snapshot.reviewChannelId),
			...ownership
		))
		.returning()
	return updated ?? null
}

export const recordReviewCaseDecision = async (
	caseId: string,
	guildId: string,
	expectedRevision: number,
	decision: {
		status: "dismissed" | "watchlist" | "confirmed_bot"
		expiresAt?: string | null
		decidedById: string
		decisionReason: string
	}
): Promise<ReviewCase | null> => {
	if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return null
	if (!guildId || !decision.decidedById) return null
	const [updated] = await getDb()
		.update(reviewCases)
		.set({
			status: decision.status,
			expiresAt: decision.expiresAt ?? null,
			decidedById: decision.decidedById,
			decisionReason: decision.decisionReason,
			cardRevision: sql`${reviewCases.cardRevision} + 1`,
			cardSyncNextAttemptAt: null,
			cardSyncFailureCount: 0,
			updatedAt: now
		})
		.where(and(
			eq(reviewCases.caseId, caseId),
			eq(reviewCases.guildId, guildId),
			eq(reviewCases.status, "escalated"),
			eq(reviewCases.cardRevision, expectedRevision)
		))
		.returning()

	return updated ?? null
}

export const markReviewCardSynced = async (
	caseId: string,
	revision: number
): Promise<ReviewCase | null> => {
	const [updated] = await getDb()
		.update(reviewCases)
		.set({
			syncedCardRevision: revision,
			cardSyncNextAttemptAt: null,
			cardSyncFailureCount: 0,
			updatedAt: now
		})
		.where(
			and(
				eq(reviewCases.caseId, caseId),
				eq(reviewCases.cardRevision, revision)
			)
		)
		.returning()

	return updated ?? null
}

export const markReviewCardStaleWrite = async (
	caseId: string,
	renderedRevision: number
): Promise<ReviewCase | null> => {
	const [updated] = await getDb()
		.update(reviewCases)
		.set({
			cardRevision: sql`${reviewCases.cardRevision} + 1`,
			cardSyncNextAttemptAt: null,
			cardSyncFailureCount: 0,
			updatedAt: now
		})
		.where(
			and(
				eq(reviewCases.caseId, caseId),
				gt(reviewCases.cardRevision, renderedRevision)
			)
		)
		.returning()

	return updated ?? null
}

export const deferReviewCardSync = async (
	caseId: string,
	backoffMs = 60_000
): Promise<ReviewCase | null> => {
	const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString()
	const [updated] = await getDb()
		.update(reviewCases)
		.set({
			cardSyncNextAttemptAt: nextAttemptAt,
			cardSyncFailureCount: sql`${reviewCases.cardSyncFailureCount} + 1`,
			updatedAt: now
		})
		.where(and(
			eq(reviewCases.caseId, caseId),
			sql`${reviewCases.syncedCardRevision} < ${reviewCases.cardRevision}`
		))
		.returning()
	return updated ?? null
}

export const allocateReescalationRevision = async (
	caseId: string,
	claimToken: string
): Promise<ReviewCase | null> => {
	if (!claimToken) return null
	const [record] = await getDb()
		.update(reviewCases)
		.set({
			cardRevision: sql`${reviewCases.cardRevision} + 1`,
			deliveryStatus: "delivering",
			cardSyncNextAttemptAt: null,
			cardSyncFailureCount: 0,
			updatedAt: now
		})
		.where(
			and(
					eq(reviewCases.caseId, caseId),
					eq(reviewCases.status, "escalated"),
					eq(reviewCases.deliveryClaimToken, claimToken)
			)
		)
		.returning()

	return record ?? null
}

export const getUndeliveredEscalations = async (
	guildId: string,
	limit = 10,
	_claimTimeoutMs = 120_000
): Promise<ReviewCase[]> => {
	return getDb()
		.select()
		.from(reviewCases)
		.where(
			and(
				eq(reviewCases.guildId, guildId),
				eq(reviewCases.status, "escalated"),
				sql`${reviewCases.deliveryStatus} IN ('pending', 'failed')`
			)
		)
			.orderBy(
				asc(reviewCases.updatedAt),
				asc(reviewCases.caseId)
			)
		.limit(limit)
}

export const expireWatchlistCases = async (): Promise<number> => {
	const expired = await getDb()
		.update(reviewCases)
		.set({
			status: "open",
			expiresAt: null,
			decisionReason: "Watchlist monitoring period expired; eligible for re-evaluation.",
			cardRevision: sql`${reviewCases.cardRevision} + 1`,
			cardSyncNextAttemptAt: null,
			cardSyncFailureCount: 0,
			updatedAt: now
		})
		.where(
			and(
				eq(reviewCases.status, "watchlist"),
				sql`expires_at IS NOT NULL AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
			)
		)
		.returning()

	return expired.length
}

export const pruneOldObservations = async (
	retentionDays = 14
): Promise<number> => {
	const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString()
	const deleted = await getDb()
		.delete(reviewObservations)
		.where(sql`created_at < ${cutoff}`)
		.returning()

	return deleted.length
}

export const getUserObservationCount = async (
	guildId: string,
	authorId: string,
	windowDays = 7
): Promise<number> => {
	if (reviewConfig.discrawlExportUrl) {
		return fetchRemoteDiscrawlCount(
			reviewConfig.discrawlExportUrl,
			reviewConfig.discrawlSecret || "",
			guildId,
			authorId,
			windowDays
		)
	}
	if (reviewConfig.discrawlExportPath) {
		return getDiscrawlObservationCount(
			reviewConfig.discrawlExportPath,
			guildId,
			authorId,
			windowDays
		)
	}

	const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString()
	const [result] = await getDb()
		.select({ count: sql<number>`count(*)` })
		.from(reviewObservations)
		.where(
			and(
				eq(reviewObservations.guildId, guildId),
				eq(reviewObservations.authorId, authorId),
				gte(reviewObservations.createdAt, cutoff)
			)
		)

	return result?.count ?? 0
}

export const listOutOfSyncCases = async (
	guildId: string,
	reviewChannelId: string,
	limit = 10
): Promise<ReviewCase[]> => {
	const currentTime = new Date().toISOString()
	return getDb()
		.select()
		.from(reviewCases)
			.where(
				and(
					eq(reviewCases.guildId, guildId),
					eq(reviewCases.reviewChannelId, reviewChannelId),
					sql`review_message_id IS NOT NULL`,
				sql`synced_card_revision < card_revision`,
				sql`(${reviewCases.cardSyncNextAttemptAt} IS NULL OR ${reviewCases.cardSyncNextAttemptAt} <= ${currentTime})`
			)
		)
		.orderBy(
			sql`COALESCE(${reviewCases.cardSyncNextAttemptAt}, ${reviewCases.updatedAt}) ASC`,
			asc(reviewCases.caseId)
		)
		.limit(limit)
}

// Receipt recovery is read-only until a conditional receipt/backoff write.
// It deliberately does not acquire the escalation claim or authorize a POST.
export const listOutstandingReviewReceipts = async (
	guildId: string,
	limit = 10,
	claimTimeoutMs = 120_000
): Promise<ReviewCase[]> => {
	const staleCutoff = new Date(Date.now() - claimTimeoutMs).toISOString()
	const backoffCutoff = new Date(Date.now() - 60_000).toISOString()
	const currentTime = new Date().toISOString()
	return getDb()
		.select()
		.from(reviewCases)
		.where(and(
			eq(reviewCases.guildId, guildId),
			sql`((${reviewCases.deliveryStatus} = 'uncertain' AND (
				(${reviewCases.receiptNextAttemptAt} IS NOT NULL AND ${reviewCases.receiptNextAttemptAt} <= ${currentTime})
				OR (${reviewCases.receiptNextAttemptAt} IS NULL AND ${reviewCases.updatedAt} <= ${backoffCutoff})
			))
				OR (${reviewCases.deliveryStatus} = 'delivering' AND (
					(${reviewCases.deliveryClaimExpiresAt} IS NOT NULL AND ${reviewCases.deliveryClaimExpiresAt} <= ${currentTime})
					OR (${reviewCases.deliveryClaimExpiresAt} IS NULL AND ${reviewCases.updatedAt} <= ${staleCutoff})
				)))`,
			sql`(${reviewCases.receiptClaimExpiresAt} IS NULL OR ${reviewCases.receiptClaimExpiresAt} <= ${currentTime})`
		))
		.orderBy(
			sql`COALESCE(${reviewCases.receiptNextAttemptAt}, ${reviewCases.updatedAt}) ASC`,
			asc(reviewCases.caseId)
		)
		.limit(limit)
}

export const claimReviewReceiptReconciliation = async (
	caseId: string,
	guildId: string,
	claimToken: string,
	claimTimeoutMs = 120_000
): Promise<ReviewCase | null> => {
	if (!claimToken) return null
	const staleCutoff = new Date(Date.now() - claimTimeoutMs).toISOString()
	const backoffCutoff = new Date(Date.now() - 60_000).toISOString()
	const currentTime = new Date().toISOString()
	const claimExpiresAt = new Date(Date.now() + claimTimeoutMs).toISOString()
	const [claimed] = await getDb()
		.update(reviewCases)
		.set({
			receiptClaimToken: claimToken,
			receiptClaimExpiresAt: claimExpiresAt,
			// Receipt reconciliation takes ownership after the delivery lease expires.
			deliveryClaimToken: null,
			deliveryClaimExpiresAt: null
		})
		.where(and(
			eq(reviewCases.caseId, caseId),
			eq(reviewCases.guildId, guildId),
			sql`((${reviewCases.deliveryStatus} = 'uncertain' AND (
				(${reviewCases.receiptNextAttemptAt} IS NOT NULL AND ${reviewCases.receiptNextAttemptAt} <= ${currentTime})
				OR (${reviewCases.receiptNextAttemptAt} IS NULL AND ${reviewCases.updatedAt} <= ${backoffCutoff})
			))
				OR (${reviewCases.deliveryStatus} = 'delivering' AND (
					(${reviewCases.deliveryClaimExpiresAt} IS NOT NULL AND ${reviewCases.deliveryClaimExpiresAt} <= ${currentTime})
					OR (${reviewCases.deliveryClaimExpiresAt} IS NULL AND ${reviewCases.updatedAt} <= ${staleCutoff})
				)))`,
			sql`(${reviewCases.receiptClaimExpiresAt} IS NULL OR ${reviewCases.receiptClaimExpiresAt} <= ${currentTime})`
		))
		.returning()
	return claimed ?? null
}

export const attachReviewCaseReceipt = async (
	snapshot: ReviewCase,
	channelId: string,
	messageId: string,
	owner: ReviewReceiptOwner
): Promise<ReviewCase | null> => {
	if (!owner.token || !channelId || !messageId ||
		(snapshot.reviewMessageId && snapshot.reviewMessageId !== messageId) ||
		(snapshot.reviewChannelId && snapshot.reviewChannelId !== channelId)) {
		throw new Error(`Conflicting review receipt for ${snapshot.caseId}`)
	}
	const [updated] = await getDb()
		.update(reviewCases)
		.set({
			reviewMessageId: messageId,
			reviewChannelId: channelId,
			deliveryStatus: "delivered",
			deliveryPreflightCompletedAt: null,
			deliveryPostAttemptedAt: null,
			deliveryAttemptState: "attempted",
			deliveryClaimToken: null,
			deliveryClaimExpiresAt: null,
			receiptClaimToken: null,
			receiptClaimExpiresAt: null,
			receiptNextAttemptAt: null,
			receiptHistoryBefore: null,
			// Receipt identity is not proof that the displayed contents are current.
			cardRevision: sql`${reviewCases.cardRevision} + 1`,
			cardSyncNextAttemptAt: null,
			cardSyncFailureCount: 0,
			updatedAt: now
		})
		.where(and(
			eq(reviewCases.caseId, snapshot.caseId),
			eq(reviewCases.guildId, snapshot.guildId),
			receiptOwnerMatches(owner),
			sql`(${reviewCases.reviewMessageId} IS NULL OR ${reviewCases.reviewMessageId} = ${messageId})`,
			sql`(${reviewCases.reviewChannelId} IS NULL OR ${reviewCases.reviewChannelId} = ${channelId})`
		))
		.returning()
	return updated ?? null
}

export const releaseUnattemptedReviewDelivery = async (
	snapshot: ReviewCase,
	claimToken: string
): Promise<ReviewCase | null> => {
	if (!claimToken) return null
	const [updated] = await getDb()
		.update(reviewCases)
		.set({
			deliveryStatus: "failed",
			deliveryPreflightCompletedAt: now,
			deliveryClaimToken: null,
			deliveryClaimExpiresAt: null,
			receiptClaimToken: null,
			receiptClaimExpiresAt: null,
			receiptNextAttemptAt: null,
			receiptHistoryBefore: null,
			updatedAt: now
		})
		.where(and(
			eq(reviewCases.caseId, snapshot.caseId),
			eq(reviewCases.guildId, snapshot.guildId),
			eq(reviewCases.receiptClaimToken, claimToken),
			 sql`${reviewCases.reviewMessageId} IS NULL`,
			sql`${reviewCases.deliveryPostAttemptedAt} IS NULL`,
			eq(reviewCases.deliveryAttemptState, "unattempted")
		))
		.returning()
	return updated ?? null
}

export const deferReviewReceiptReconciliation = async (
	snapshot: ReviewCase,
	claimToken: string,
	historyBefore: string | null = snapshot.receiptHistoryBefore,
	backoffMs = 60_000
): Promise<ReviewCase | null> => {
	if (!claimToken || !["uncertain", "delivering"].includes(snapshot.deliveryStatus)) return null
	const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString()
	const [updated] = await getDb()
		.update(reviewCases)
		.set({
			deliveryStatus: "uncertain",
			deliveryClaimToken: null,
			deliveryClaimExpiresAt: null,
			receiptClaimToken: null,
			receiptClaimExpiresAt: null,
			receiptNextAttemptAt: nextAttemptAt,
			receiptHistoryBefore: historyBefore,
			updatedAt: now
		})
		.where(and(
			eq(reviewCases.caseId, snapshot.caseId),
			eq(reviewCases.guildId, snapshot.guildId),
			eq(reviewCases.receiptClaimToken, claimToken)
		))
		.returning()
	return updated ?? null
}

export const beginReviewCardWrite = async (
	reviewCase: ReviewCase,
	renderedRevision: number,
	attemptToken: string,
	initialDelayMs = 120_000
): Promise<ReviewCardWriteAttempt> => {
	if (!attemptToken || !reviewCase.reviewChannelId || !reviewCase.reviewMessageId) {
		throw new Error(`Cannot persist shared-card write attempt for ${reviewCase.caseId}`)
	}
	const [attempt] = await getDb()
		.insert(reviewCardWriteAttempts)
		.values({
			attemptToken,
			caseId: reviewCase.caseId,
			guildId: reviewCase.guildId,
			channelId: reviewCase.reviewChannelId,
			messageId: reviewCase.reviewMessageId,
			renderedRevision,
			nextAttemptAt: new Date(Date.now() + initialDelayMs).toISOString()
		})
		.returning()
	if (!attempt) throw new Error(`Failed to persist shared-card write attempt for ${reviewCase.caseId}`)
	return attempt
}

export const completeReviewCardWrite = async (attemptToken: string): Promise<boolean> => {
	const deleted = await getDb()
		.delete(reviewCardWriteAttempts)
		.where(eq(reviewCardWriteAttempts.attemptToken, attemptToken))
		.returning()
	return deleted.length === 1
}

export const listOutstandingReviewCardWrites = async (
	guildId: string,
	limit = 10
): Promise<ReviewCardWriteAttempt[]> => {
	const currentTime = new Date().toISOString()
	return getDb()
		.select()
		.from(reviewCardWriteAttempts)
		.where(and(
			eq(reviewCardWriteAttempts.guildId, guildId),
			sql`(${reviewCardWriteAttempts.nextAttemptAt} IS NULL OR ${reviewCardWriteAttempts.nextAttemptAt} <= ${currentTime})`,
			sql`(${reviewCardWriteAttempts.claimExpiresAt} IS NULL OR ${reviewCardWriteAttempts.claimExpiresAt} <= ${currentTime})`
		))
		.orderBy(asc(reviewCardWriteAttempts.createdAt), asc(reviewCardWriteAttempts.attemptToken))
		.limit(limit)
}

export const claimOutstandingReviewCardWrite = async (
	attemptToken: string,
	claimToken: string,
	claimTimeoutMs = 120_000
): Promise<ReviewCardWriteAttempt | null> => {
	if (!claimToken) return null
	const currentTime = new Date().toISOString()
	const claimExpiresAt = new Date(Date.now() + claimTimeoutMs).toISOString()
	const [claimed] = await getDb()
		.update(reviewCardWriteAttempts)
		.set({ claimToken, claimExpiresAt })
		.where(and(
			eq(reviewCardWriteAttempts.attemptToken, attemptToken),
			sql`(${reviewCardWriteAttempts.claimExpiresAt} IS NULL OR ${reviewCardWriteAttempts.claimExpiresAt} <= ${currentTime})`
		))
		.returning()
	return claimed ?? null
}

export const reconcileOutstandingReviewCardWrite = async (
	attempt: ReviewCardWriteAttempt,
	claimToken: string,
	verificationDelayMs = 120_000
): Promise<ReviewCase | null> => {
	const [updated] = await getDb()
		.update(reviewCases)
		.set({
			cardRevision: sql`${reviewCases.cardRevision} + 1`,
			cardSyncNextAttemptAt: null,
			cardSyncFailureCount: 0,
			updatedAt: now
		})
		.where(and(
			eq(reviewCases.caseId, attempt.caseId),
			eq(reviewCases.guildId, attempt.guildId),
			eq(reviewCases.reviewChannelId, attempt.channelId),
			eq(reviewCases.reviewMessageId, attempt.messageId)
		))
		.returning()
	if (!updated) return null
	if (attempt.failureCount === 0) {
		const [retained] = await getDb()
			.update(reviewCardWriteAttempts)
			.set({
				claimToken: null,
				claimExpiresAt: null,
				nextAttemptAt: new Date(Date.now() + verificationDelayMs).toISOString(),
				failureCount: 1
			})
			.where(and(
				eq(reviewCardWriteAttempts.attemptToken, attempt.attemptToken),
				eq(reviewCardWriteAttempts.claimToken, claimToken)
			))
			.returning()
		if (!retained) throw new Error(`Lost shared-card write ownership for ${attempt.caseId}`)
	} else {
		const deleted = await getDb()
			.delete(reviewCardWriteAttempts)
			.where(and(
				eq(reviewCardWriteAttempts.attemptToken, attempt.attemptToken),
				eq(reviewCardWriteAttempts.claimToken, claimToken)
			))
			.returning()
		if (deleted.length !== 1) throw new Error(`Lost shared-card write ownership for ${attempt.caseId}`)
	}
	return updated
}

export const deferOutstandingReviewCardWrite = async (
	attemptToken: string,
	claimToken: string,
	backoffMs = 60_000
): Promise<boolean> => {
	const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString()
	const [updated] = await getDb()
		.update(reviewCardWriteAttempts)
		.set({
			claimToken: null,
			claimExpiresAt: null,
			nextAttemptAt,
			failureCount: sql`${reviewCardWriteAttempts.failureCount} + 1`
		})
		.where(and(
			eq(reviewCardWriteAttempts.attemptToken, attemptToken),
			eq(reviewCardWriteAttempts.claimToken, claimToken)
		))
		.returning()
	return Boolean(updated)
}
