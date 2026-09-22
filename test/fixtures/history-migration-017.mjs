import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {mkdir,readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {zstdCompressSync} from 'node:zlib';
const require = createRequire(process.argv[2]);
createRequire(import.meta.url)(process.argv[3]).registerDfySessionFormatCompatibility();
const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const {default:Persistence}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')));
const {createRuntimeResolution,PluginPackages}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')));
const runtimeHome=await mkdtemp(join(tmpdir(),'dfy-migration-runtime-'));
const runtimeContext=new Context();
try {
// Exercise the same inherited resolver in the verification Worker as a full DSH launch.
await runtimeContext.plugin(PluginPackages,{resolution:await createRuntimeResolution({installAnchor:process.argv[2],home:runtimeHome})});
const media={type:'dfy-media',version:1,resource:{kind:'image',ref:'fixture-image',attachment:{attachmentId:'sha256:'+'a'.repeat(64),mediaType:'image/png',bytes:68,width:1,height:1}}};
for(const version of [2,3]) for(const compression of ['none','zstd']) {
 const root=await mkdtemp(join(tmpdir(),'dfy-v4-history-'));
 const id='session-017-fixture';const dir=join(root,'_no-cwd',id);await mkdir(dir,{recursive:true});
 const message={id:'q',role:'user',source:{kind:'user'},content:[{type:'text',text:'旧图片'},media]};
 const rows=[{type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[message]}},{type:'turn/start',data:{turn:1}},{type:'step/start',data:{turn:1,step:1}},{type:'user/message',surfaceOp:'append',data:message},{type:'step/end',data:{turn:1,step:1}},{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}].map((r,seq)=>({...r,seq,time:1000+seq}));
 const header={type:'session',version,id,createdAt:1,isSeeded:false,delegationDepth:0};
 const raw=[header,...rows].map(r=>JSON.stringify(r)+'\n').join('');
 const source=join(dir,`session.v${version}.jsonl${compression==='zstd'?'.zstd':''}`);
 const bytes=compression==='zstd'?Buffer.concat([zstdCompressSync(Buffer.from(JSON.stringify(header)+'\n')),zstdCompressSync(Buffer.from(rows.map(r=>JSON.stringify(r)+'\n').join('')))]):Buffer.from(raw);await writeFile(source,bytes);
 const ctx=new Context();
 try {
  await ctx.plugin(Persistence,{root,compression});
  for(const access of ['read','write','read']) {
   const handle=await ctx.sessionPersistence.open(id,access);
   try {const result=await handle.read();assert.equal(handle.header.version,4);const user=result.events.find(e=>e.type==='user/message');assert.equal(user.data.content[1].type,'plugin:dfy-media');assert.deepEqual(user.data.content[1].resource,media.resource);} finally {await handle.close();}
  }
  assert.deepEqual(await readFile(source),bytes);console.log(`PASS V${version} ${compression} → V4, original preserved`);
 } finally {await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});}
}
} finally {await runtimeContext.fiber.dispose();await rm(runtimeHome,{recursive:true,force:true});}
