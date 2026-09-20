/** Compare wire-visible components, ignoring only server-assigned component IDs. */
export function normalizeProofCard(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeProofCard)
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value)
			.filter(([key, item]) => key !== "id" && item !== undefined)
			.map(([key, item]) => [key, normalizeProofCard(item)]))
	}
	return value
}
