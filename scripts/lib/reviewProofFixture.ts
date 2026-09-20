export interface ReviewProofFixtureInput {
	guildId: string
	channelId: string
	targetUserId: string
	nowMs: number
}

export interface ReviewProofFixtureMessage {
	id: string
	guild_id: string
	channel_id: string
	author: { id: string; username: string }
	content: string
	timestamp: string
	message_reference?: { message_id: string }
}

/** Synthetic export only: this function performs no I/O and sends no messages.
 * IDs prefixed with synthetic-review are fixture identities, not Discord receipts.
 * The deliberately strong signals exercise plumbing, not detector accuracy.
 */
export function buildReviewProofFixture({
	guildId,
	channelId,
	targetUserId,
	nowMs
}: ReviewProofFixtureInput): { messages: ReviewProofFixtureMessage[] } {
	if (!guildId || !channelId || !targetUserId || !Number.isSafeInteger(nowMs)) {
		throw new Error("Synthetic review fixture requires IDs and a safe integer timestamp")
	}

	const messages: ReviewProofFixtureMessage[] = []
	for (let index = 0; index < 24; index++) {
		const parentId = `synthetic-review-parent-${index}`
		const parentTime = nowMs - (24 - index) * 120_000
		messages.push({
			id: parentId,
			guild_id: guildId,
			channel_id: channelId,
			author: {
				id: `synthetic-review-parent-author-${targetUserId}`,
				username: "synthetic-review-parent"
			},
			content: `Synthetic fixture request ${index}: describe the numbered sample.`,
			timestamp: new Date(parentTime).toISOString()
		})
		messages.push({
			id: `synthetic-review-reply-${index}`,
			guild_id: guildId,
			channel_id: channelId,
			author: { id: targetUserId, username: "synthetic-review-target" },
			content: [
				`Synthetic fixture response ${index}; no community message is represented.`,
				"assistant to=functions.synthetic_fixture",
				"1. **Observation** The numbered synthetic sample contains a bounded set of generated records.",
				"2. **Validation** Each record is derived from a deterministic fixture and has a known timestamp.",
				"3. **Result** This controlled sample exercises the review pipeline without observing a real member."
			].join("\n"),
			timestamp: new Date(parentTime + 1_200).toISOString(),
			message_reference: { message_id: parentId }
		})
	}
	return { messages }
}
