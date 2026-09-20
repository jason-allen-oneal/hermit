/** Fail closed before importing any network-capable proof dependency. */
export function readLiveProofConfig(env: Record<string, string | undefined>) {
	const required = (name: string) => {
		const value = env[name]?.trim()
		if (!value) throw new Error(`Missing ${name}`)
		return value
	}
	const snowflake = (name: string) => {
		const value = required(name)
		if (!/^[1-9][0-9]{16,19}$/.test(value)) throw new Error(`Invalid ${name}`)
		return value
	}
	const guildId = snowflake("HERMIT_PROOF_GUILD_ID")
	const channelId = snowflake("HERMIT_PROOF_CHANNEL_ID")
	const botId = snowflake("DISCORD_CLIENT_ID")
	if (guildId === "1456350064065904867" || channelId === "1519064274561929328") {
		throw new Error("Live proof refuses the production review guild/channel")
	}
	if (env.ENABLE_AUTOMATIC_SCREENING === "1" || env.ENABLE_AUTOMATIC_SCREENING === "true") {
		throw new Error("Automatic screening must remain disabled")
	}
	return { guildId, channelId, botId, token: required("DISCORD_BOT_TOKEN") }
}
