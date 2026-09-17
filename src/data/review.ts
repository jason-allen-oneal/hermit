import { and, eq, gte, sql, desc, inArray } from "drizzle-orm"
import { getDb } from "../db.js"
import {
	reviewCases,
	reviewObservations,
	type NewReviewCase,
	type NewReviewObservation,
	type ReviewCase,
	type ReviewObservation
} from "../db/schema.js"
import type { ReviewMessage } from "../review/types.js"

const now = sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

export const recordObservation = async (
	observation: NewReviewObservation
): Promise<ReviewObservation | null> => {
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
	const [reviewCase] = await getDb()
		.insert(reviewCases)
		.values(data)
		.onConflictDoUpdate({
			target: [reviewCases.caseId],
			set: {
				heuristicScore: data.heuristicScore,
				concordance: data.concordance,
				behavioralFamilies: data.behavioralFamilies,
				evidenceMessageId: data.evidenceMessageId,
				krillProbability: data.krillProbability,
				krillBrief: data.krillBrief,
				krillModel: data.krillModel,
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
