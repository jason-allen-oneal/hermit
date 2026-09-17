import type { Client } from "@buape/carbon"
import {
	expireWatchlistCases,
	pruneOldObservations
} from "../data/review.js"
import {
	recoverReviewEscalations,
	recoverSharedCardSync
} from "./reviewNotifier.js"

export const runReviewMaintenance = async (client: Client) => {
	try {
		// 1. Expire watchlist cases past 7 days and return them to monitoring
		await expireWatchlistCases()

		// 2. Prune observations older than 14-day retention policy
		await pruneOldObservations(14)

		// 3. Retry undelivered / failed review escalation cards
		await recoverReviewEscalations(client)

		// 4. Recover shared cards that failed synchronization
		await recoverSharedCardSync(client)
	} catch (error) {
		console.error("Error in runReviewMaintenance:", error)
	}
}
