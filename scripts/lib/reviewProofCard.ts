/** Compare wire-visible components, accounting for IDs and omitted button defaults. */
export function normalizeProofCard(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeProofCard)
	if (value && typeof value === "object") {
		const component = value as { type?: unknown }
		return Object.fromEntries(Object.entries(value)
			.filter(([key, item]) => key !== "id" && item !== undefined &&
				// Discord omits false on enabled buttons; true remains observable.
				!(component.type === 2 && key === "disabled" && item === false))
			.map(([key, item]) => [key, normalizeProofCard(item)]))
	}
	return value
}
