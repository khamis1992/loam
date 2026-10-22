import ts from 'typescript';
for(const file of ['sample.ts','sample.js']){
const source='const pgp=require("pg-promise")(); const db=pgp("fixture"); db.any("SELECT $1:raw",input);';
const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
const checker=ts.createProgram([file],{noLib:true,noResolve:true,allowJs:true},{getSourceFile:n=>n===file?ast:undefined,getDefaultLibFileName:()=>'',writeFile:()=>{},getCurrentDirectory:()=>'',getDirectories:()=>[],fileExists:n=>n===file,readFile:n=>n===file?source:undefined,getCanonicalFileName:n=>n,useCaseSensitiveFileNames:()=>true,getNewLine:()=> '\n'}).getTypeChecker();
const visit=(node:ts.Node)=>{if(ts.isIdentifier(node)){const s=checker.getSymbolAtLocation(node);console.log(file,node.text,node.pos,s?.flags,s?.declarations?.map(d=>ts.SyntaxKind[d.kind]));}ts.forEachChild(node,visit);};visit(ast);
}
