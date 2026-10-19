import ts from 'typescript';
import {pgRawReferences} from './source-pg-format.js';

export interface SqlSourceRisk {line:number;rule:string;snippet:string;severity:'medium';check:'source_sql'}

/** Syntactic review candidates, not taint analysis or proof of SQL injection. */
export function analyzeSqlSource(file:string,source:string):{risks:SqlSourceRisk[];status:'analyzed'|'unsupported'|'parse_error'|'limit_reached'}{
  if(!/\.(?:[cm]?js|tsx?)$/i.test(file))return {risks:[],status:'unsupported'};
  const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  if((ast as ts.SourceFile & {parseDiagnostics?:readonly ts.Diagnostic[]}).parseDiagnostics?.length)return {risks:[],status:'parse_error'};
  const result:SqlSourceRisk[]=[];
  // Bind this file only: no filesystem reads, imports, libraries or type checking.
  // TypeScript's binder handles lexical shadowing, parameters and catch bindings.
  let checker:ts.TypeChecker|undefined;
  const getChecker=()=>checker??=ts.createProgram([file],{noLib:true,noResolve:true,allowJs:true},{
    getSourceFile:name=>name===file?ast:undefined,
    getDefaultLibFileName:()=>'',writeFile:()=>{},getCurrentDirectory:()=>'',
    getDirectories:()=>[],fileExists:name=>name===file,readFile:name=>name===file?source:undefined,
    getCanonicalFileName:name=>name,useCaseSensitiveFileNames:()=>true,getNewLine:()=> '\n',
  }).getTypeChecker();
  const executionScope=(node:ts.Node):ts.Node=>{
    let current=node.parent;
    while(current&&!ts.isSourceFile(current)&&!ts.isFunctionLike(current))current=current.parent;
    return current??ast;
  };
  let writtenSymbols:Set<ts.Symbol>|undefined;
  const mutations=()=>{
    if(writtenSymbols)return writtenSymbols;
    writtenSymbols=new Set();
    const record=(node:ts.Node)=>{
      if(ts.isShorthandPropertyAssignment(node)){const symbol=getChecker().getShorthandAssignmentValueSymbol(node);if(symbol)writtenSymbols!.add(symbol);}
      if(ts.isIdentifier(node)){const symbol=getChecker().getSymbolAtLocation(node);if(symbol)writtenSymbols!.add(symbol);}
      ts.forEachChild(node,record);
    };
    const scan=(node:ts.Node)=>{
      if(ts.isBinaryExpression(node)&&node.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&node.operatorToken.kind<=ts.SyntaxKind.LastAssignment)record(node.left);
      if((ts.isPrefixUnaryExpression(node)||ts.isPostfixUnaryExpression(node))&&(node.operator===ts.SyntaxKind.PlusPlusToken||node.operator===ts.SyntaxKind.MinusMinusToken))record(node.operand);
      if(ts.isForInStatement(node)||ts.isForOfStatement(node))record(node.initializer);
      ts.forEachChild(node,scan);
    };
    scan(ast);return writtenSymbols;
  };
  const unwrap=(value:ts.Expression):ts.Expression=>{
    while(ts.isParenthesizedExpression(value)||ts.isAsExpression(value)||ts.isTypeAssertionExpression(value)||ts.isNonNullExpression(value))value=value.expression;
    return value;
  };
  let remainingParts=0,limitReached=false;
  const prefix=(text:string)=>{if(text.length>4096)limitReached=true;return text.slice(0,4096);};
  const parts=(expression:ts.Expression,depth=0):{literal:string;dynamic:boolean}=>{
    if(depth===0)remainingParts=2048;
    if(depth>32||--remainingParts<0){limitReached=true;return {literal:'',dynamic:true};}
    const e=unwrap(expression);
    if(ts.isIdentifier(e)){
      const symbol=ts.isShorthandPropertyAssignment(e.parent)?getChecker().getShorthandAssignmentValueSymbol(e.parent):getChecker().getSymbolAtLocation(e);
      const declarations=symbol?.declarations;
      const declaration=declarations?.length===1?declarations[0]:undefined;
      if(declaration&&ts.isVariableDeclaration(declaration)&&ts.isIdentifier(declaration.name)
        &&ts.isVariableDeclarationList(declaration.parent)&&symbol&&!mutations().has(symbol)
        &&declaration.initializer&&declaration.end<e.getStart(ast)
        &&executionScope(declaration)===executionScope(e))return parts(declaration.initializer,depth+1);
      return {literal:'',dynamic:true};
    }
    if(ts.isStringLiteral(e)||ts.isNoSubstitutionTemplateLiteral(e))return {literal:e.text,dynamic:false};
    if(ts.isNumericLiteral(e))return {literal:e.text,dynamic:false};
    if(ts.isTemplateExpression(e)){
      let literal=e.head.text,dynamic=false;
      for(const span of e.templateSpans){const p=parts(span.expression,depth+1);literal=prefix(literal+p.literal+span.literal.text);dynamic ||=p.dynamic;}
      return {literal,dynamic};
    }
    if(ts.isBinaryExpression(e)&&e.operatorToken.kind===ts.SyntaxKind.PlusToken){const a=parts(e.left,depth+1),b=parts(e.right,depth+1);return {literal:prefix(a.literal+b.literal),dynamic:a.dynamic||b.dynamic};}
    return {literal:'',dynamic:true};
  };
  const pgOrigin=(expression:ts.Expression,depth=0):'module'|'factory'|'database'|undefined=>{
    if(depth>16){limitReached=true;return;}
    const e=unwrap(expression);
    if(ts.isIdentifier(e)){
      const symbol=getChecker().getSymbolAtLocation(e),ds=symbol?.declarations;
      if(!symbol||mutations().has(symbol)||ds?.length!==1)return;
      const d=ds[0]!;
      if(ts.isImportClause(d)&&d.name&&ts.isImportDeclaration(d.parent)&&ts.isStringLiteral(d.parent.moduleSpecifier)&&d.parent.moduleSpecifier.text==='pg-promise'&&!d.isTypeOnly)return 'module';
      if(ts.isVariableDeclaration(d)&&ts.isIdentifier(d.name)&&d.initializer&&d.end<e.getStart(ast))return pgOrigin(d.initializer,depth+1);
      return;
    }
    if(!ts.isCallExpression(e))return;
    if(ts.isIdentifier(e.expression)&&e.expression.text==='require'&&!getChecker().getSymbolAtLocation(e.expression)?.declarations?.length
      &&e.arguments.length===1&&ts.isStringLiteral(e.arguments[0]!)&&e.arguments[0].text==='pg-promise')return 'module';
    const origin=pgOrigin(e.expression,depth+1);
    if(origin==='factory')return 'database';
    if(origin==='module'){
      // Unknown initialization options could select native pg formatting instead.
      const options=e.arguments[0]&&unwrap(e.arguments[0]);
      if(options){
        if(!ts.isObjectLiteralExpression(options))return;
        for(const p of options.properties){
          if(!ts.isPropertyAssignment(p)||!(ts.isIdentifier(p.name)||ts.isStringLiteral(p.name)))return;
          if(p.name.text==='pgFormatting'&&p.initializer.kind!==ts.SyntaxKind.FalseKeyword)return;
        }
      }
      return 'factory';
    }
  };
  const rawValue=(values:ts.Expression,ref:{index:number}|{name:string}):ts.Expression|undefined=>{
    let value=unwrap(values);
    if('index' in ref){
      if(ts.isArrayLiteralExpression(value)){
        if(value.elements.some(ts.isSpreadElement))return value;
        const item=value.elements[ref.index];return item&&!ts.isOmittedExpression(item)?item:undefined;
      }
      return ref.index===0?value:undefined;
    }
    for(const name of ref.name.split('.')){
      if(!ts.isObjectLiteralExpression(value))return value;
      if(value.properties.some(p=>ts.isSpreadAssignment(p)||!p.name||ts.isComputedPropertyName(p.name)))return value;
      const member=[...value.properties].reverse().find(p=>p.name&&(ts.isIdentifier(p.name)||ts.isStringLiteral(p.name))&&p.name.text===name);
      if(!member)return;
      if(ts.isPropertyAssignment(member))value=unwrap(member.initializer);
      else if(ts.isShorthandPropertyAssignment(member))return member.name;
      else return value;
    }
    return value;
  };
  const visit=(node:ts.Node)=>{
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.arguments.length){
      const method=node.expression.name.text;
      if(['query','execute','raw','get','all','run','each','exec','prepare','any','many','manyOrNone','map','multi','multiResult','none','one','oneOrNone','result','$queryRawUnsafe','$executeRawUnsafe'].includes(method)){
        let argument=unwrap(node.arguments[0]!);let values=node.arguments[1];
        if(ts.isObjectLiteralExpression(argument)){
          const member=argument.properties.find(p=>ts.isPropertyAssignment(p)&&((ts.isIdentifier(p.name)||ts.isStringLiteral(p.name))&&['text','sql'].includes(p.name.text)));
          if(member&&ts.isPropertyAssignment(member))argument=unwrap(member.initializer);
          const valueMember=(unwrap(node.arguments[0]!) as ts.ObjectLiteralExpression).properties.find(p=>ts.isPropertyAssignment(p)&&(ts.isIdentifier(p.name)||ts.isStringLiteral(p.name))&&p.name.text==='values');
          if(valueMember&&ts.isPropertyAssignment(valueMember))values=valueMember.initializer;
        }
        const p=parts(argument),explicitUnsafe=method==='$queryRawUnsafe'||method==='$executeRawUnsafe';
        if(p.dynamic&&(explicitUnsafe||/^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP|EXEC|CALL)\b/i.test(p.literal))){
          result.push({check:'source_sql',severity:'medium',line:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1,rule:'Dynamic SQL construction (review parameter binding)',snippet:`AST: ${method} receives dynamic SQL text. Query contents omitted. Review input provenance and driver parameter binding; exploitability is not established.`});
        }else if(!p.dynamic&&values&&['query','any','many','manyOrNone','map','each','multi','multiResult','none','one','oneOrNone','result'].includes(method)&&pgRawReferences(p.literal).length&&pgOrigin(node.expression.expression)==='database'){
          const unsafe=pgRawReferences(p.literal).some(ref=>{
            const value=rawValue(values!,ref);
            return value&&![ts.SyntaxKind.NullKeyword,ts.SyntaxKind.TrueKeyword,ts.SyntaxKind.FalseKeyword].includes(unwrap(value).kind)&&parts(value).dynamic;
          });
          if(unsafe)result.push({check:'source_sql',severity:'medium',line:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1,
            rule:'Raw SQL parameter formatting (review escaping)',snippet:`AST: pg-promise ${method} uses a raw formatting modifier with a nonconstant value. Query and parameter contents omitted. Review value provenance and use ordinary escaped placeholders; exploitability is not established.`});
        }
      }
    }
    ts.forEachChild(node,visit);
  };
  visit(ast);return {risks:result,status:limitReached?'limit_reached':'analyzed'};
}
export function inspectSqlConstruction(file:string,source:string):SqlSourceRisk[]{return analyzeSqlSource(file,source).risks;}
