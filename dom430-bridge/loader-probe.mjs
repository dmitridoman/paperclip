import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
process.env.NODE_ENV='production';process.env.PAPERCLIP_LOG_LEVEL='silent';
let stage='loader-import',root,result;
try {
 const {loadExternalAdapterPackage}=await import('../server/src/adapters/plugin-loader.ts');
 stage='factory-load';root=mkdtempSync(join(tmpdir(),'dom430-pc-probe-'));
 writeFileSync(join(root,'package.json'),JSON.stringify({name:'dom430-probe',type:'module',exports:{'.':'./index.mjs'}}));
 writeFileSync(join(root,'index.mjs'),'export {createServerAdapter} from '+JSON.stringify(new URL('./adapter.ts',import.meta.url).href)+';\n');
 const adapter=await loadExternalAdapterPackage('dom430-probe',root);
 result={stage,loaded:!!adapter,type:adapter?.type};
} catch(error) {
 const allowed=['ERR_MODULE_NOT_FOUND','ERR_PACKAGE_PATH_NOT_EXPORTED','ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX','ERR_UNKNOWN_FILE_EXTENSION','ERR_INVALID_PACKAGE_TARGET','ENOENT','EACCES','EROFS'];
 const text=typeof error?.message==='string'?error.message:'';
 const packageName=text.match(/Cannot find package '([@a-zA-Z0-9_./-]+)'/)?.[1];
 const path=typeof error?.url==='string'?error.url:typeof error?.path==='string'?error.path:text.match(/Cannot find module '([^']+)'/)?.[1];
 const name=path?basename(path):undefined;
 result={stage,loaded:false,code:allowed.includes(error?.code)?error.code:'unclassified',...(packageName?{packageName}:{}),...(name&&/^[a-zA-Z0-9_.-]{1,96}$/.test(name)?{moduleBasename:name}:{})};
} finally {if(root)rmSync(root,{recursive:true,force:true});}
console.log(JSON.stringify({schema:'dom430.pc.bridge.v1',kind:'diagnostic',result}));
