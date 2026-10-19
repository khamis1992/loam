import ts from 'typescript';

export function htmlInsertionRisks(file:string,source:string){
  if(!/\.(?:[cm]?js|tsx?)$/i.test(file))return [];
  const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  if((ast as any).parseDiagnostics?.length)return [];
  const risks:Array<{severity:'low';rule:string;line:number;snippet:string;check:'source_html'}>=[];
  const visit=(node:ts.Node)=>{
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='insertAdjacentHTML'){
      risks.push({severity:'low',rule:'HTML insertion via insertAdjacentHTML (verify XSS sanitization)',line:ast.getLineAndCharacterOfPosition(node.expression.getStart(ast)).line+1,snippet:node.getText(ast).slice(0,140),check:'source_html'});
    }
    ts.forEachChild(node,visit);
  };
  visit(ast);return risks;
}
