import {
	Button,
	type ButtonInteraction,
	ButtonStyle,
	type ComponentData,
	Container,
	Row,
	Separator,
	TextDisplay
} from "@buape/carbon"
import { reviewConfig } from "../config/review.js"
import {
	beginReviewCardWrite,
	completeReviewCardWrite,
	markReviewCardStaleWrite,
	markReviewCardSynced,
	recordReviewCaseDecision
} from "../data/review.js"
import type { ReviewCase } from "../db/schema.js"

type PersistedReviewSignal = {
	code: string
	family: string
	description: string
}

const parsePersistedReviewSignals = (value: string): PersistedReviewSignal[] => {
	try {
		const parsed = JSON.parse(value)
		if (!Array.isArray(parsed)) return []
		return parsed.filter((signal): signal is PersistedReviewSignal =>
			Boolean(signal) && typeof signal === "object" &&
			typeof signal.code === "string" &&
			typeof signal.family === "string" &&
			typeof signal.description === "string"
		).slice(0, 3)
	} catch {
		return []
	}
}

const hasStaffRole = (interaction: ButtonInteraction) =>
	interaction.member?.roles.some((role) =>
		(reviewConfig.staffRoleIds as readonly string[]).includes(role.id)
	) ?? false

export const buildReviewCardContainer = (
	reviewCase: ReviewCase,
	closed = false
) => {
	const keySignals = parsePersistedReviewSignals(reviewCase.keySignals)
	const accentColor =
		reviewCase.status === "confirmed_bot"
			? "#f85149"
			: reviewCase.status === "dismissed"
				? "#3fb950"
				: reviewCase.status === "watchlist"
					? "#f1c40f"
					: "#d29922"

	const statusText =
		reviewCase.status === "watchlist" && reviewCase.expiresAt
			? `WATCHLIST (expires <t:${Math.floor(new Date(reviewCase.expiresAt).getTime() / 1000)}:R>)`
			: reviewCase.status.toUpperCase()

	const lines: (TextDisplay | Separator | Row<Button>)[] = [
		new TextDisplay("### 🦞 Claw & Order | Automation Review"),
		new TextDisplay(
			`**Target Account:** <@${reviewCase.targetUserId}>\n**Status:** ${statusText}`
		),
		new Separator({ divider: true, spacing: "small" }),
		new TextDisplay(
			`**Heuristic Score:** ${reviewCase.heuristicScore}/100\n` +
				`**Signal Concordance:** ${reviewCase.concordance} (${reviewCase.behavioralFamilies})\n` +
				`**Krill Assessment Probability (Model Estimate):** ${reviewCase.krillProbability || "Not evaluated"}\n` +
				`**Model:** ${reviewCase.krillModel || "N/A"}`
		)
	]

	if (reviewCase.krillBrief) {
		lines.push(
			new Separator({ divider: true, spacing: "small" }),
			new TextDisplay(`**Krill Assessment Brief**\n${reviewCase.krillBrief}`)
		)
	}

	if (keySignals.length > 0) {
		lines.push(
			new Separator({ divider: true, spacing: "small" }),
			new TextDisplay(
				`**Key Detected Signals:**\n` +
					keySignals
						.map((s) => `• **${s.code}** (${s.family}): ${s.description}`)
						.join("\n")
			)
		)
	}

	if (reviewCase.decidedById) {
		lines.push(
			new Separator({ divider: true, spacing: "small" }),
			new TextDisplay(
				`-# Decision by <@${reviewCase.decidedById}>: ${reviewCase.decisionReason || "No reason given"}`
			)
		)
	}

	if (!closed && reviewCase.status === "escalated") {
		lines.push(
			new Separator({ divider: true, spacing: "small" }),
			new Row([
				new ReviewDismissButton(reviewCase.caseId, reviewCase.cardRevision),
				new ReviewWatchlistButton(reviewCase.caseId, reviewCase.cardRevision),
				new ReviewConfirmBotButton(reviewCase.caseId, reviewCase.cardRevision)
			])
		)
	}

	// This identity survives removal of all decision buttons.
	lines.push(new TextDisplay(`-# hermit-review:v1:${reviewCase.caseId}`))
	return new Container(lines, { accentColor })
}

const buildPermissionDeniedContainer = () =>
	new Container(
		[
			new TextDisplay("### Permission required"),
			new TextDisplay("Community Team or Maintainer role required.")
		],
		{ accentColor: "#f85149" }
	)

const buildChangedCaseContainer = () =>
	new Container(
		[
			new TextDisplay("### Review case changed"),
			new TextDisplay(
				"This case has changed or is already decided.\nRun `/review` again before taking another action."
			)
		],
		{ accentColor: "#d29922" }
	)

const buildReviewCustomId = (prefix: string, caseId: string, revision: number): string => {
	if (!caseId || !Number.isSafeInteger(revision) || revision < 1) {
		throw new TypeError("Review buttons require a case ID and positive safe revision")
	}
	const customId = `${prefix}:caseId=${caseId};rev=${revision}`
	if (customId.length > 100) {
		throw new RangeError("Review button custom ID exceeds Discord's 100-character limit")
	}
	return customId
}

const finishReviewDecision = async (
	interaction: ButtonInteraction,
	updated: ReviewCase
): Promise<void> => {
	const targetsSharedCard = Boolean(updated.reviewMessageId) &&
		interaction.message?.id === updated.reviewMessageId
	let needsSharedSync = Boolean(updated.reviewMessageId && updated.reviewChannelId)
	const persistenceErrors: unknown[] = []
	const writeAttemptToken = targetsSharedCard ? crypto.randomUUID() : null
	if (writeAttemptToken) {
		await beginReviewCardWrite(updated, updated.cardRevision, writeAttemptToken)
	}
	try {
		await interaction.update({
			components: [buildReviewCardContainer(updated, true)],
			allowedMentions: { parse: [] }
		})
		if (targetsSharedCard) {
			const synced = await markReviewCardSynced(updated.caseId, updated.cardRevision)
			needsSharedSync = !synced
			if (synced && writeAttemptToken) {
				if (!await completeReviewCardWrite(writeAttemptToken)) {
					throw new Error(`Failed to close interaction card write for ${updated.caseId}`)
				}
			} else if (!synced) {
				await markReviewCardStaleWrite(updated.caseId, updated.cardRevision)
			}
		}
	} catch (error) {
		console.warn("Failed to update review decision interaction:", error)
		if (targetsSharedCard) {
			try {
				await markReviewCardStaleWrite(updated.caseId, updated.cardRevision)
			} catch (persistenceError) {
				persistenceErrors.push(persistenceError)
			}
		}
	}

	// An ephemeral success is not a shared-card acknowledgment, and an
	// ephemeral failure must not prevent attempting the shared-card repair.
	if (needsSharedSync) {
		try {
			const { syncSharedReviewCard } = await import("../services/reviewNotifier.js")
			await syncSharedReviewCard(interaction.client, updated)
		} catch (error) {
			persistenceErrors.push(error)
		}
	}
	if (persistenceErrors.length > 0) {
		throw new AggregateError(persistenceErrors, "Failed to persist review card repair work")
	}
}

type ReviewDecision = {
	status: "dismissed" | "watchlist" | "confirmed_bot"
	expiresAt?: string | null
	decisionReason: string
}

const applyReviewDecision = async (
	interaction: ButtonInteraction,
	data: ComponentData,
	decision: ReviewDecision
): Promise<void> => {
	if (interaction.guild?.id !== reviewConfig.guildId || !hasStaffRole(interaction)) {
		await interaction.reply({
			components: [buildPermissionDeniedContainer()],
			ephemeral: true
		})
		return
	}

	const caseId = typeof data?.caseId === "string" ? data.caseId : undefined
	const expectedRevision = typeof data?.rev === "number" &&
		Number.isSafeInteger(data.rev) && data.rev > 0 ? data.rev : undefined
	const actorId = interaction.user?.id || interaction.userId
	if (!caseId || !expectedRevision || !actorId) {
		await interaction.reply({
			components: [buildChangedCaseContainer()],
			ephemeral: true
		})
		return
	}

	const updated = await recordReviewCaseDecision(
		caseId,
		reviewConfig.guildId,
		expectedRevision,
		{
			...decision,
			decidedById: actorId
		}
	)
	if (!updated) {
		await interaction.reply({
			components: [buildChangedCaseContainer()],
			ephemeral: true
		})
		return
	}
	await finishReviewDecision(interaction, updated)
}

export class ReviewDismissButton extends Button {
	customId = "review-dismiss"
	label = "Dismiss (Human)"
	style = ButtonStyle.Secondary
	ephemeral = true
	defer = false

	constructor(caseId?: string, revision?: number) {
		super()
		if (caseId) {
			this.customId = buildReviewCustomId("review-dismiss", caseId, revision ?? 0)
		}
	}

	async run(interaction: ButtonInteraction, data: ComponentData) {
		await applyReviewDecision(interaction, data, {
			status: "dismissed",
			expiresAt: null,
			decisionReason: "Marked as human / dismissed by staff."
		})
	}
}

export class ReviewWatchlistButton extends Button {
	customId = "review-watchlist"
	label = "Watchlist (7d)"
	style = ButtonStyle.Primary
	ephemeral = true
	defer = false

	constructor(caseId?: string, revision?: number) {
		super()
		if (caseId) {
			this.customId = buildReviewCustomId("review-watchlist", caseId, revision ?? 0)
		}
	}

	async run(interaction: ButtonInteraction, data: ComponentData) {
		const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString()
		await applyReviewDecision(interaction, data, {
			status: "watchlist",
			expiresAt,
			decisionReason: "Added to watchlist for 7 days."
		})
	}
}

export class ReviewConfirmBotButton extends Button {
	customId = "review-confirm-bot"
	label = "Confirm Bot"
	style = ButtonStyle.Danger
	ephemeral = true
	defer = false

	constructor(caseId?: string, revision?: number) {
		super()
		if (caseId) {
			this.customId = buildReviewCustomId("review-confirm-bot", caseId, revision ?? 0)
		}
	}

	async run(interaction: ButtonInteraction, data: ComponentData) {
		await applyReviewDecision(interaction, data, {
			status: "confirmed_bot",
			expiresAt: null,
			decisionReason: "Confirmed automated agent account."
		})
	}
}

export const reviewComponents = [
	new ReviewDismissButton(),
	new ReviewWatchlistButton(),
	new ReviewConfirmBotButton()
]
