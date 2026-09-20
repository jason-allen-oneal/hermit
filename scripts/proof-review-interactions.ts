/** Opt-in actual Discord Gateway command/button ingress; never deployed.
 * Own temporary test-guild command is removed in finally; operator owns test-role lifecycle.
 * Local D1, synthetic Discrawl, unchanged Carbon router/ReviewCommand/buttons.
 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { appendFile, mkdir, readdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { readLiveProofConfig } from "./lib/reviewLiveProofConfig.js"
import { normalizeProofCard } from "./lib/reviewProofCard.js"

assert.deepEqual(process.argv.slice(2), ["--live"], "Explicit --live required")
const config = readLiveProofConfig(process.env)
const actors = (process.env.HERMIT_PROOF_ACTOR_IDS || "").split(",")
assert(actors.length > 0 && actors.every(id => /^[1-9][0-9]{16,19}$/.test(id)))
// Provider proof is separate; never spend/infer silently in this ingress run.
assert(!process.env.OPENAI_API_KEY, "Use separate provider proof; no key in ingress process")
const repo = resolve(import.meta.dir, "..")
const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding:"utf8" }).trim()
assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding:"utf8" }).trim(), "")
const root = resolve(process.env.XDG_STATE_HOME || resolve(process.env.HOME!, ".local/state"), "hermit-interaction-proof", randomUUID())
await mkdir(root, {recursive:true,mode:0o700})
const emit = async (event:string, detail:Record<string,unknown>={}) => {
 await appendFile(resolve(root,"evidence.jsonl"), JSON.stringify({at:new Date().toISOString(),head,event,...detail})+"\n",{mode:0o600})
 console.log(event)
}
console.warn = () => { console.log("Service warning (details suppressed)") }
console.error = () => { console.log("Service error (details suppressed)") }
const {Client,Routes,InteractionCreateListener,serializePayload} = await import("@buape/carbon")
const {GatewayPlugin} = await import("@buape/carbon/gateway")
const {getPlatformProxy} = await import("wrangler")
const {reviewConfig} = await import("../src/config/review.js")
const {setRuntimeEnv} = await import("../src/runtime/env.js")
const data = await import("../src/data/review.js")
const {postReviewEscalationCard} = await import("../src/services/reviewNotifier.js")
const {reviewComponents,buildReviewCardContainer} = await import("../src/components/reviewButtons.js")
const {default:ReviewCommand} = await import("../src/commands/review.js")
const {buildReviewProofFixture} = await import("./lib/reviewProofFixture.js")
const {applyReviewMigrations} = await import("./lib/reviewMigrationProof.js")
const {startDiscrawlServer} = await import("../forwarder/src/discrawlServer.js")
let cleanupD1: (()=>Promise<void>)|undefined, stopBridge: (()=>void)|undefined
const roleId=process.env.HERMIT_PROOF_STAFF_ROLE_ID
assert(roleId && /^[1-9][0-9]{16,19}$/.test(roleId),"Supply externally managed zero-permission test role")
let commandId:string|undefined, timer: ReturnType<typeof setTimeout>|undefined
let stage=0, actor:string|undefined, staleMessageId:string|undefined, sharedId:string|undefined
let resolveDone!:()=>void, rejectDone!:(error:unknown)=>void
const done=new Promise<void>((resolve,reject)=>{resolveDone=resolve;rejectDone=reject})
const caseId=`case-${config.guildId}-${config.botId}`
const command=new ReviewCommand()
let client:InstanceType<typeof Client>
class ProofListener extends InteractionCreateListener {
 async handle(raw:any) {
  if(raw.guild_id!==config.guildId || raw.channel_id!==config.channelId || !actors.includes(raw.member?.user?.id)) return
  if(raw.type===2 && raw.data?.name!=="review") return
  if(raw.type===3 && !raw.data?.custom_id?.startsWith("review-")) return
  if(![2,3].includes(raw.type)) return
  try {
   if(actor) assert.equal(raw.member.user.id,actor)
   if(raw.type===2) {
    assert([0,1].includes(stage),"Unexpected command stage")
    assert.equal(raw.data.options?.find((x:any)=>x.name==="user")?.value,config.botId,"Only synthetic bot subject")
   } else {
    assert([2,3].includes(stage),"Unexpected component stage")
    assert.equal(raw.message.id,stage===2?staleMessageId:sharedId)
    assert(raw.data.custom_id.startsWith("review-dismiss:"),"Use Dismiss only")
   }
   const before=await data.getReviewCase(caseId)
   // Unmodified real Gateway interaction, including actual role claims and token.
   await client.handleInteraction(raw,{})
   const response:any=await client.rest.get(`/webhooks/${config.botId}/${raw.token}/messages/@original`)
   const responseText=JSON.stringify(response.components)
   if(stage===0) {
    assert(!raw.member.roles.includes(roleId))
    assert(responseText.includes("Staff role required")); assert.equal(await data.getReviewCase(caseId),null)
    actor=raw.member.user.id
    await emit("real_nonstaff_command_rejected",{caseCreated:false})
    stage=1;await emit("awaiting_external_test_role_assignment_then_authorized_review_command")
   } else if(stage===1) {
    assert(raw.member.roles.includes(roleId))
    let current=await data.getReviewCase(caseId);assert(current?.status==="escalated")
    assert(responseText.includes("review-dismiss:"));staleMessageId=response.id
    await emit("real_staff_command_case_verified",{revision:current.cardRevision,status:current.status})
    await postReviewEscalationCard(client,current)
    current=await data.getReviewCase(caseId);assert(current?.reviewMessageId);sharedId=current.reviewMessageId
    stage=2;await emit("awaiting_stale_ephemeral_dismiss",{sharedRevision:current.cardRevision})
   } else if(stage===2) {
    assert(responseText.includes("Review case changed"))
    const current=await data.getReviewCase(caseId)
    assert.equal(current?.status,"escalated");assert.equal(current?.cardRevision,before?.cardRevision)
    await emit("real_stale_button_rejected",{decisionUnchanged:true})
    stage=3;await emit("awaiting_current_shared_dismiss")
   } else {
    const current=await data.getReviewCase(caseId);assert(current?.reviewMessageId)
    assert.equal(current.status,"dismissed");assert.equal(current.decidedById,actor)
    assert.equal(current.cardRevision,current.syncedCardRevision)
    const card:any=await client.rest.get(Routes.channelMessage(config.channelId,current.reviewMessageId))
    const expected=serializePayload({components:[buildReviewCardContainer(current,true)],allowedMentions:{parse:[]}})
    assert.deepEqual(normalizeProofCard(card.components),normalizeProofCard(expected.components))
    assert(!JSON.stringify(card.components).includes("review-dismiss:"))
    await emit("real_staff_button_decision_and_card_verified",{status:current.status,desired:current.cardRevision,synced:current.syncedCardRevision,buttonsRemoved:true})
    stage=4;resolveDone()
   }
  } catch(error) {rejectDone(error)}
 }
}
client=new Client({clientId:config.botId,token:config.token,publicKey:"0".repeat(64),baseUrl:"http://127.0.0.1",disableDeployRoute:true,autoDeploy:false,requestOptions:{queueRequests:false}}, {commands:[command],components:reviewComponents,listeners:[new ProofListener()]})
const gateway=new GatewayPlugin({intents:0,autoInteractions:false,eventFilter:(type:string)=>type==="INTERACTION_CREATE"||type==="READY"})
gateway.emitter.on("error",()=>{console.log("Gateway error; details suppressed")})
try {
 const bot:any=await client.rest.get("/users/@me");assert.equal(bot.id,config.botId);assert(bot.bot)
 const app:any=await client.rest.get("/oauth2/applications/@me");assert(!app.interactions_endpoint_url,"Do not divert existing endpoint")
 const channel:any=await client.rest.get(Routes.channel(config.channelId));assert.equal(channel.guild_id,config.guildId);assert.equal(channel.type,0)
 const messages:any=await client.rest.get(Routes.channelMessages(config.channelId),{limit:1});assert.equal(messages.length,0)
 const commandRoute=`/applications/${config.botId}/guilds/${config.guildId}/commands`
 const commands:any=await client.rest.get(commandRoute);assert(!commands.some((c:any)=>c.name==="review"),"Never replace an existing command")
 const globalCommands:any=await client.rest.get(`/applications/${config.botId}/commands`);assert(!globalCommands.some((c:any)=>c.name==="review"),"Never shadow an existing global command")
 await emit("started",{database:"local Wrangler D1",transport:"actual Discord Gateway interaction -> unchanged Carbon router -> production command/buttons -> real callback/GET",providerExercised:false,limits:["No deployed Worker","No provider request","Test process guild/channel/staff role overrides"]})
 const wranglerPath=resolve(root,"wrangler.json")
 await writeFile(wranglerPath,JSON.stringify({name:"hermit-interaction-proof",compatibility_date:"2026-09-08",compatibility_flags:["nodejs_compat"],d1_databases:[{binding:"DB",database_name:"isolated-proof",database_id:"00000000-0000-0000-0000-000000000001"}]}))
 const proxy=await getPlatformProxy<{DB:D1Database}>({configPath:wranglerPath,envFiles:[],remoteBindings:false,persist:{path:resolve(root,"d1")}})
 cleanupD1=()=>proxy.dispose();setRuntimeEnv({DB:proxy.env.DB} as Env)
 const migrations=resolve(repo,"drizzle");await applyReviewMigrations(proxy.env.DB,migrations,(await readdir(migrations)).filter(f=>f.endsWith(".sql")).sort())
 const fixturePath=resolve(root,"synthetic-export.json")
 await writeFile(fixturePath,JSON.stringify(buildReviewProofFixture({guildId:config.guildId,channelId:config.channelId,targetUserId:config.botId,nowMs:Date.now()})),{mode:0o600})
 const secret=randomUUID()+randomUUID();const bridge=startDiscrawlServer({exportPath:fixturePath,secret,port:0});stopBridge=()=>bridge.stop(true)
 delete process.env.DISCRAWL_EXPORT_PATH;process.env.DISCRAWL_EXPORT_URL=`http://127.0.0.1:${bridge.port}`;process.env.DISCRAWL_SECRET=secret;process.env.ENABLE_AUTOMATIC_SCREENING="false"
 const roles:any=await client.rest.get(`/guilds/${config.guildId}/roles`)
 const role=roles.find((entry:any)=>entry.id===roleId);assert(role && role.permissions==="0","Test role must exist with zero permissions")
 Object.assign(reviewConfig,{guildId:config.guildId,reviewChannelId:config.channelId,staffRoleIds:[roleId]})
 const registered:any=await client.rest.post(commandRoute,{body:command.serialize()});commandId=registered.id
 await gateway.registerClient(client)
 timer=setTimeout(()=>rejectDone(new Error("Interaction proof timed out")),15*60_000)
 await emit("awaiting_nonstaff_review_command")
 await done
 await emit("passed",{actualCommands:2,actualButtons:2,realPermissionRejection:true,realStaleRejection:true})
} catch(error) {
 await emit("failed",{stage,errorType:error instanceof Error?error.name:"unknown",status:typeof (error as any)?.status==="number"?(error as any).status:null,code:typeof (error as any)?.code==="number"?(error as any).code:null})
 process.exitCode=1
} finally {
 if(timer)clearTimeout(timer)
 gateway.disconnect()
 let cleanupFailed=false
 if(commandId)try{await client.rest.delete(`/applications/${config.botId}/guilds/${config.guildId}/commands/${commandId}`)}catch{cleanupFailed=true}
 stopBridge?.();await cleanupD1?.()
 await emit("cleanup",{temporaryCommandRemoved:!cleanupFailed,externalTestRoleCleanupRequired:true})
 if(cleanupFailed)process.exitCode=1
 console.log(`Private evidence retained at ${root}`)
}
