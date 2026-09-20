import { describe, expect, it } from "bun:test"
import { readLiveProofConfig } from "../scripts/lib/reviewLiveProofConfig.js"
import { normalizeProofCard } from "../scripts/lib/reviewProofCard.js"
import { Container, Row, TextDisplay, serializePayload } from "@buape/carbon"
import { ReviewDismissButton } from "../src/components/reviewButtons.js"

const configured = {
	HERMIT_PROOF_GUILD_ID: "900000000000000001",
	HERMIT_PROOF_CHANNEL_ID: "900000000000000002",
	DISCORD_CLIENT_ID: "900000000000000003",
	DISCORD_BOT_TOKEN: "synthetic-only-not-a-credential"
}

describe("live proof scope preflight (no network)", () => {
	it("compares actual Carbon payloads using JSON wire semantics without hiding state changes", () => {
		const payload = serializePayload({ components: [new Container([
			new TextDisplay("Synthetic"), new Row([new ReviewDismissButton("proof-case", 2)])
		])] })
		const wire = JSON.parse(JSON.stringify(payload.components))
		wire[0].id = 1
		wire[0].components[0].id = 2
		expect(normalizeProofCard(payload.components)).toEqual(normalizeProofCard(wire))
		wire[0].components[0].content = "Stale synthetic state"
		expect(normalizeProofCard(payload.components)).not.toEqual(normalizeProofCard(wire))
	})
	it("rejects missing inputs before any live action", () => {
		expect(() => readLiveProofConfig({})).toThrow("HERMIT_PROOF_GUILD_ID")
		expect(() => readLiveProofConfig({ ...configured, DISCORD_BOT_TOKEN: "" })).toThrow("DISCORD_BOT_TOKEN")
	})
	it("refuses production guild and channel independently", () => {
		expect(() => readLiveProofConfig({ ...configured, HERMIT_PROOF_GUILD_ID: "1456350064065904867" })).toThrow("production")
		expect(() => readLiveProofConfig({ ...configured, HERMIT_PROOF_CHANNEL_ID: "1519064274561929328" })).toThrow("production")
	})
	it("refuses automatic screening and malformed coordinates", () => {
		for (const value of ["1", "true"]) {
			expect(() => readLiveProofConfig({ ...configured, ENABLE_AUTOMATIC_SCREENING: value })).toThrow("disabled")
		}
		expect(() => readLiveProofConfig({ ...configured, HERMIT_PROOF_CHANNEL_ID: "../other" })).toThrow("Invalid")
	})
	it("resolves only explicitly supplied test coordinates", () => {
		expect(readLiveProofConfig(configured)).toEqual({
			guildId: configured.HERMIT_PROOF_GUILD_ID,
			channelId: configured.HERMIT_PROOF_CHANNEL_ID,
			botId: configured.DISCORD_CLIENT_ID,
			token: configured.DISCORD_BOT_TOKEN
		})
	})
})
