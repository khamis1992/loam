import ts from 'typescript';

export interface NoSqlSourceRisk {line:number;rule:string;snippet:string;severity:'medium';check:'source_nosql'}
/** Bounded request-shaped filter review, not receiver typing or exploit confirmation. */
export function analyzeNoSqlSource(file:string,source:string):{risks:NoSqlSourceRisk[];status:'analyzed'|'unsupported'|'parse_error'|'limit_reached'}{
  if(!/\.(?:[cm]?js|tsx?)$/i.test(file))return {risks:[],status:'unsupported'};
  const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  if((ast as ts.SourceFile&{parseDiagnostics?:readonly ts.Diagnostic[]}).parseDiagnostics?.length)return {risks:[],status:'parse_error'};
  const checker=ts.createProgram([file],{noLib:true,noResolve:true,allowJs:true},{getSourceFile:n=>n===file?ast:undefined,getDefaultLibFileName:()=>'',writeFile:()=>{},getCurrentDirectory:()=>'',getDirectories:()=>[],fileExists:n=>n===file,readFile:n=>n===file?source:undefined,getCanonicalFileName:n=>n,useCaseSensitiveFileNames:()=>true,getNewLine:()=> '\n'}).getTypeChecker();
  const unwrap=(value:ts.Expression):ts.Expression=>{while(ts.isParenthesizedExpression(value)||ts.isAsExpression(value)||ts.isTypeAssertionExpression(value)||ts.isNonNullExpression(value))value=value.expression;return value;};
  const key=(name:ts.PropertyName)=>ts.isIdentifier(name)||ts.isStringLiteral(name)?name.text:undefined;
  const symbol=(node:ts.Identifier)=>ts.isShorthandPropertyAssignment(node.parent)?checker.getShorthandAssignmentValueSymbol(node.parent):checker.getSymbolAtLocation(node);
  const written=new Set<ts.Symbol>();let library=false;
  const propertyWrites=new Map<ts.Symbol,ts.BinaryExpression[]>();
  const mark=(node:ts.Node)=>{if(ts.isIdentifier(node)){const s=symbol(node);if(s)written.add(s);}ts.forEachChild(node,mark);};
  const prepare=(node:ts.Node)=>{
    if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&['mongodb','mongoose'].includes(node.moduleSpecifier.text)&&!node.importClause?.isTypeOnly)library=true;
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='require'&&!checker.getSymbolAtLocation(node.expression)?.declarations?.length&&node.arguments.length===1&&ts.isStringLiteral(node.arguments[0]!)&&['mongodb','mongoose'].includes(node.arguments[0].text))library=true;
    if(ts.isBinaryExpression(node)&&node.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&node.operatorToken.kind<=ts.SyntaxKind.LastAssignment){
      const left=unwrap(node.left);
      if(node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&(ts.isPropertyAccessExpression(left)||ts.isElementAccessExpression(left))&&ts.isIdentifier(left.expression)){
        const s=symbol(left.expression);if(s){const writes=propertyWrites.get(s)??[];writes.push(node);propertyWrites.set(s,writes);}
      }else mark(node.left);
    }
    if((ts.isPrefixUnaryExpression(node)||ts.isPostfixUnaryExpression(node))&&(node.operator===ts.SyntaxKind.PlusPlusToken||node.operator===ts.SyntaxKind.MinusMinusToken))mark(node.operand);
    if(ts.isForInStatement(node)||ts.isForOfStatement(node))mark(node.initializer);
    ts.forEachChild(node,prepare);
  };prepare(ast);
  if(!library)return {risks:[],status:'analyzed'};
  const scope=(node:ts.Node)=>{let p=node.parent;while(p&&!ts.isSourceFile(p)&&!ts.isFunctionLike(p))p=p.parent;return p;};
  const capturedWithin=(declaration:ts.Node,use:ts.Node)=>{
    const owner=scope(declaration);let p:ts.Node|undefined=use;
    while(p){if(p===owner)return true;p=p.parent;}
    return false;
  };
  const requestSource=(expression:ts.Expression,includeParams=false)=>{
    let e=unwrap(expression);const names:string[]=[];
    while(ts.isPropertyAccessExpression(e)||ts.isElementAccessExpression(e)){
      const name=ts.isPropertyAccessExpression(e)?e.name.text:ts.isStringLiteral(e.argumentExpression)?e.argumentExpression.text:undefined;
      if(!name)return false;names.unshift(name);e=unwrap(e.expression);
    }
    if(!ts.isIdentifier(e)||!['body','query',...(includeParams?['params']:[])].includes(names[0]??''))return false;
    const s=symbol(e);return !!s&&!written.has(s)&&!propertyWrites.has(s)&&s.declarations?.length===1&&ts.isParameter(s.declarations[0]!);
  };
  let remaining=0,limited=false,sinkPosition=0;
  const block=(node:ts.Node)=>{let p=node.parent;while(p&&!ts.isBlock(p)&&!ts.isSourceFile(p))p=p.parent;return p;};
  const guardedScalar=(identifier:ts.Identifier,s:ts.Symbol)=>{
    let child:ts.Node=identifier;
    for(let p=child.parent;p&&!ts.isFunctionLike(p);child=p,p=p.parent){
      if(!ts.isIfStatement(p)||p.thenStatement!==child)continue;
      const c=unwrap(p.expression);
      if(!ts.isBinaryExpression(c)||c.operatorToken.kind!==ts.SyntaxKind.EqualsEqualsEqualsToken)continue;
      for(const [a,b] of [[c.left,c.right],[c.right,c.left]]){
        if(a&&b&&ts.isTypeOfExpression(a)&&ts.isIdentifier(a.expression)&&symbol(a.expression)===s&&ts.isStringLiteral(b)&&['string','number','boolean','bigint'].includes(b.text))return true;
      }
    }
    return false;
  };
  const tainted=(expression:ts.Expression,depth=0,includeParams=false):boolean=>{
    if(depth===0){remaining=2048;sinkPosition=expression.getStart(ast);}
    if(depth>32||--remaining<0){limited=true;return false;}
    const e=unwrap(expression);
    if(requestSource(e,includeParams))return true;
    if(ts.isIdentifier(e)){
      const s=symbol(e),ds=s?.declarations,d=ds?.length===1?ds[0]:undefined;
      if(s&&!written.has(s)&&!includeParams&&guardedScalar(e,s))return false;
      if(!(s&&!written.has(s)&&d&&ts.isVariableDeclaration(d)&&ts.isIdentifier(d.name)&&d.initializer&&d.end<e.getStart(ast)&&capturedWithin(d,e)))return false;
      if(tainted(d.initializer,depth+1,includeParams))return true;
      // Only local object construction with unconditional expression statements.
      // Earlier tainted writes are retained as review candidates, not proof of a live value.
      if(!ts.isObjectLiteralExpression(unwrap(d.initializer)))return false;
      return (propertyWrites.get(s)??[]).some(w=>{
        if(--remaining<0){limited=true;return false;}
        if(w.end>=sinkPosition||w.getStart(ast)<=d.end||!ts.isExpressionStatement(w.parent)||block(w)!==block(d)||scope(w)!==scope(d))return false;
        const left=unwrap(w.left);
        if(!ts.isPropertyAccessExpression(left)&&!ts.isElementAccessExpression(left))return false;
        const name=ts.isPropertyAccessExpression(left)?left.name.text:ts.isStringLiteral(left.argumentExpression)?left.argumentExpression.text:undefined;
        if(name==='$eq')return false;
        return (ts.isElementAccessExpression(left)&&tainted(left.argumentExpression,depth+1,includeParams))||tainted(w.right,depth+1,includeParams);
      });
    }
    if(ts.isObjectLiteralExpression(e))return e.properties.some(p=>{
      if(ts.isSpreadAssignment(p))return tainted(p.expression,depth+1,includeParams);
      if(ts.isShorthandPropertyAssignment(p))return tainted(p.name,depth+1,includeParams);
      if(ts.isPropertyAssignment(p)){
        // Explicit equality contains the user value as data, not an operator object.
        if(key(p.name)==='$eq')return false;
        return (ts.isComputedPropertyName(p.name)&&tainted(p.name.expression,depth+1,includeParams))||tainted(p.initializer,depth+1,includeParams);
      }
      return false;
    });
    if(ts.isArrayLiteralExpression(e))return e.elements.some(x=>ts.isSpreadElement(x)?tainted(x.expression,depth+1,includeParams):!ts.isOmittedExpression(x)&&tainted(x,depth+1,includeParams));
    if(ts.isConditionalExpression(e))return tainted(e.whenTrue,depth+1,includeParams)||tainted(e.whenFalse,depth+1,includeParams);
    if(ts.isCallExpression(e)&&ts.isPropertyAccessExpression(e.expression)&&ts.isIdentifier(e.expression.expression)&&e.expression.expression.text==='JSON'&&e.expression.name.text==='parse'&&!checker.getSymbolAtLocation(e.expression.expression)?.declarations?.length&&e.arguments[0])return tainted(e.arguments[0],depth+1,true);
    return false;
  };
  const risks:NoSqlSourceRisk[]=[];
  // Narrow library provenance for excluding known error/number callback receivers.
  // This is not general receiver typing, and unknown origins retain review candidates.
  const origin=(expression:ts.Expression,depth=0):string|undefined=>{
    if(depth>16)return undefined;
    const e=unwrap(expression);
    if(ts.isIdentifier(e)){
      const s=symbol(e),ds=s?.declarations,d=ds?.length===1?ds[0]:undefined;
      if(!s||written.has(s)||!d)return undefined;
      if((propertyWrites.get(s)??[]).some(w=>{
        const left=unwrap(w.left);
        const name=ts.isPropertyAccessExpression(left)?left.name.text:ts.isElementAccessExpression(left)&&ts.isStringLiteral(left.argumentExpression)?left.argumentExpression.text:undefined;
        return !name||['model','find','findOne','findById','count','countDocuments','estimatedDocumentCount','exec','then'].includes(name);
      }))return undefined;
      if(ts.isVariableDeclaration(d)&&d.initializer&&d.end<e.getStart(ast))return origin(d.initializer,depth+1);
      if(ts.isImportClause(d)&&!d.isTypeOnly&&ts.isImportDeclaration(d.parent)&&ts.isStringLiteral(d.parent.moduleSpecifier)&&d.parent.moduleSpecifier.text==='mongoose')return 'mongoose';
    }
    if(!ts.isCallExpression(e))return undefined;
    if(ts.isIdentifier(e.expression)&&e.expression.text==='require'&&!checker.getSymbolAtLocation(e.expression)?.declarations?.length&&e.arguments.length===1&&ts.isStringLiteral(e.arguments[0]!)&&e.arguments[0].text==='mongoose')return 'mongoose';
    if(!ts.isPropertyAccessExpression(e.expression))return undefined;
    const parent=origin(e.expression.expression,depth+1),method=e.expression.name.text;
    if(parent==='mongoose'&&method==='model')return 'model';
    if(parent==='model'&&['find','findOne','findById'].includes(method))return 'documents';
    if(parent==='model'&&['count','countDocuments','estimatedDocumentCount'].includes(method))return 'number';
    if((parent==='documents'||parent==='number')&&method==='exec')return parent;
    return undefined;
  };
  const nonQueryReceiver=(expression:ts.Expression)=>{
    const e=unwrap(expression);if(!ts.isIdentifier(e))return false;
    const s=symbol(e),ds=s?.declarations,p=ds?.length===1?ds[0]:undefined;
    if(!s||written.has(s)||propertyWrites.has(s)||!p||!ts.isParameter(p))return false;
    const callback=p.parent;
    if(!ts.isArrowFunction(callback)&&!ts.isFunctionExpression(callback))return false;
    const call=callback.parent;if(!ts.isCallExpression(call)||!ts.isPropertyAccessExpression(call.expression))return false;
    const index=callback.parameters.indexOf(p),argument=call.arguments.indexOf(callback),method=call.expression.name.text;
    const parent=origin(call.expression.expression),result=origin(call);
    if(method==='then'&&(parent==='documents'||parent==='number'))return (argument===1&&index===0)||(argument===0&&index===0&&parent==='number');
    if(argument!==call.arguments.length-1)return false;
    if(result==='documents'||result==='number')return index===0||(index===1&&result==='number');
    return false;
  };
  const methods=new Set(['find','findOne','findById','count','countDocuments','deleteOne','deleteMany','findOneAndDelete','findOneAndRemove','findOneAndUpdate','replaceOne','update','updateOne','updateMany','remove','aggregate','where','and','or']);
  const visit=(node:ts.Node)=>{
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)){
      const method=node.expression.name.text,index=method==='distinct'?1:0;
      if((methods.has(method)||method==='distinct')&&node.arguments[index]&&!nonQueryReceiver(node.expression.expression)&&tainted(node.arguments[index]!))risks.push({check:'source_nosql',severity:'medium',line:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1,rule:'Request-shaped NoSQL filter (review operator injection)',snippet:`AST: ${method} receives request body/query-shaped data in a filter in a file importing MongoDB/Mongoose. Filter contents omitted. Verify receiver type, input schema, allowed operators and driver sanitization; exploitability is not established.`});
    }
    ts.forEachChild(node,visit);
  };visit(ast);return {risks,status:limited?'limit_reached':'analyzed'};
}
