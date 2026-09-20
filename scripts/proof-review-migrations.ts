/** Isolated local D1 migration proof. No remote bindings or deployed services. */
import assert from "node:assert/strict"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { readdirSync } from "node:fs"
import { resolve } from "node:path"
import { getPlatformProxy } from "wrangler"
import {
	applyReviewMigrations,
	assertReviewSchema,
	verifyPopulatedReviewUpgrade
} from "./lib/reviewMigrationProof.js"

const proofRoot = resolve(`/tmp/hermit-review-migrations-${Date.now()}`)
const drizzleDir = resolve(import.meta.dir, "../drizzle")
const files = readdirSync(drizzleDir).filter((file) => file.endsWith(".sql")).sort()
const disposers: Array<() => Promise<void>> = []
let originalError: unknown

await mkdir(proofRoot, { recursive: true })

try {
	assert(files.length > 0, "No migrations found")
	const freshRoot = resolve(proofRoot, "fresh-install")
	await mkdir(freshRoot, { recursive: true })
	const configPath = resolve(freshRoot, "wrangler.json")
	await writeFile(configPath, JSON.stringify({
		name: "hermit-review-fresh-migration-proof",
		compatibility_date: "2026-09-08",
		compatibility_flags: ["nodejs_compat"],
		d1_databases: [{
			binding: "DB",
			database_name: "hermit-review-fresh-proof",
			database_id: "00000000-0000-0000-0000-000000000003"
		}]
	}))
	const fresh = await getPlatformProxy<{ DB: D1Database }>({
		configPath,
		envFiles: [],
		remoteBindings: false,
		persist: { path: resolve(freshRoot, "state") }
	})
	let freshDisposed = false
	const disposeFresh = async () => {
		if (!freshDisposed) {
			await fresh.dispose()
			freshDisposed = true
		}
	}
	disposers.push(disposeFresh)
	await applyReviewMigrations(fresh.env.DB, drizzleDir, files)
	await assertReviewSchema(fresh.env.DB)
	console.log(`Fresh local D1 migration sequence verified through ${files.at(-1)}.`)
	await disposeFresh()

	await verifyPopulatedReviewUpgrade(
		drizzleDir,
		files,
		proofRoot,
		(dispose) => disposers.push(dispose)
	)
	console.log("Migration proof passed: fresh install, populated upgrade, and negative preservation control.")
} catch (error) {
	originalError = error
	throw error
} finally {
	let cleanupError: unknown
	const disposed = await Promise.allSettled(disposers.map((dispose) => dispose()))
	const failures = disposed.filter((result) => result.status === "rejected")
	if (failures.length > 0) {
		cleanupError = new AggregateError(
			failures.map((result) => result.reason),
			"Local migration proof proxy disposal failed"
		)
	}
	if (!cleanupError) {
		try {
			await rm(proofRoot, { recursive: true, force: true })
		} catch (error) {
			cleanupError = error
		}
	}
	if (cleanupError) {
		if (originalError) console.error("Migration proof cleanup also failed:", cleanupError)
		else throw cleanupError
	}
}
