import { AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel, LevelFormat, PageNumber, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, TableLayoutType, ShadingType, VerticalAlign, ImageRun } from "docx";
import sharp from "sharp";
import type { StudioArtifact } from "./store.js";

type WordArtifact = Extract<StudioArtifact, { kind: "document" }>;
const rtl = (text: string) => /[\u0590-\u08ff]/u.test(text);
const ink = "182332", accent = "087F8C", muted = "687787";

/** Native, editable report layout. Imported documents retain their original template. */
export async function createWordDocument(artifact: WordArtifact, options: { contentWidth?: number; omitTitle?: boolean } = {}): Promise<Document> {
  const documentRtl = rtl(artifact.title + artifact.content.blocks.map(b => b.text + (b.type === 'stats' ? b.items.map(s=>s.value+s.label).join('') : b.type === 'table' ? b.columns.join('')+b.rows.flat().join('') : b.type === 'image' ? b.alt : '')).join(""));
  const run = (text: string, size = 24, bold = false, italic = false, color = ink) => new TextRun({
    text, font: "Arial", size, sizeComplexScript: size, bold, boldComplexScript: bold,
    italics: italic, italicsComplexScript: italic, color, rightToLeft: rtl(text),
  });
  const children: (Paragraph | Table)[] = [new Paragraph({
    heading: HeadingLevel.TITLE, bidirectional: rtl(artifact.title),
    alignment: rtl(artifact.title) ? AlignmentType.RIGHT : AlignmentType.LEFT,
    spacing: { before: 120, after: 280 }, keepNext: true,
    border: { bottom: { style: BorderStyle.SINGLE, color: accent, size: 18, space: 16 } },
    children: [run(artifact.title, 44, true)],
  })];
  const blocks = artifact.content.blocks;
  if(options.omitTitle)children.length=0;
  const width=options.contentWidth ?? 9638;
  const border={style:BorderStyle.SINGLE,color:"DCE5EB",size:4};
  const none={style:BorderStyle.NONE,size:0,color:"FFFFFF"};
  const caption=(text:string)=>new Paragraph({alignment:documentRtl?AlignmentType.RIGHT:AlignmentType.LEFT,bidirectional:rtl(text),spacing:{before:100,after:200},children:[run(text,20,false,false,muted)]});
  const gap=()=>new Paragraph({spacing:{before:0,after:120,line:120},children:[]});
  // Models sometimes repeat the title as their first heading. Render it once.
  const start = blocks[0]?.type === "heading" && blocks[0].text.trim() === artifact.title.trim() ? 1 : 0;
  for (let index = start; index < blocks.length; index++) {
    const block = blocks[index]!;
    if(block.type === "stats") {
      const cellWidth=Math.floor(width/block.items.length);
      const palette={teal:["EAF5F2","176758"],blue:["EDF2FC","365D9B"],amber:["FFF4DE","805B15"]};
      children.push(new Table({width:{size:width,type:WidthType.DXA},columnWidths:block.items.map(()=>cellWidth),layout:TableLayoutType.FIXED,visuallyRightToLeft:documentRtl,
        margins:{top:180,bottom:180,left:180,right:180},
        rows:[new TableRow({cantSplit:true,children:block.items.map(item=>{
          const [fill,color]=palette[item.tone];
          return new TableCell({width:{size:cellWidth,type:WidthType.DXA},shading:{fill,type:ShadingType.CLEAR},verticalAlign:VerticalAlign.CENTER,borders:{top:none,bottom:none,left:{style:BorderStyle.SINGLE,color:"FFFFFF",size:24},right:{style:BorderStyle.SINGLE,color:"FFFFFF",size:24}},children:[
            new Paragraph({alignment:AlignmentType.CENTER,bidirectional:rtl(item.value),spacing:{after:80},children:[run(item.value,38,true,false,color)]}),
            new Paragraph({alignment:AlignmentType.CENTER,bidirectional:rtl(item.label),spacing:{after:0,line:280},children:[run(item.label,21,false,false,ink)]}),
          ]});})})]}));
      children.push(block.text?caption(block.text):gap());continue;
    }
    if(block.type === "table") {
      const cellWidth=Math.floor(width/block.columns.length);
      if(block.text)children.push(new Paragraph({keepNext:true,bidirectional:rtl(block.text),alignment:documentRtl?AlignmentType.RIGHT:AlignmentType.LEFT,spacing:{before:120,after:120},children:[run(block.text,23,true)]}));
      children.push(new Table({width:{size:width,type:WidthType.DXA},columnWidths:block.columns.map(()=>cellWidth),layout:TableLayoutType.FIXED,visuallyRightToLeft:documentRtl,margins:{top:130,bottom:130,left:150,right:150},
        rows:[block.columns,...block.rows].map((row,r)=>new TableRow({tableHeader:r===0,cantSplit:true,children:row.map(value=>new TableCell({width:{size:cellWidth,type:WidthType.DXA},verticalAlign:VerticalAlign.CENTER,shading:{fill:r===0?"182F3A":r%2?"F0F6F6":"FFFFFF",type:ShadingType.CLEAR},borders:{top:none,left:none,right:none,bottom:border},children:value.split(/\r?\n/).map(line=>new Paragraph({bidirectional:rtl(line),alignment:documentRtl?AlignmentType.RIGHT:AlignmentType.LEFT,spacing:{after:0,line:280},children:[run(line,21,r===0,false,r===0?"FFFFFF":ink)]}))}))}))}));
      children.push(gap());continue;
    }
    if(block.type === "image") {
      // Decode and re-encode a bounded raster: no external relationships or file/network reads.
      const data=Buffer.from(block.src.slice(block.src.indexOf(',')+1),'base64');
      const {data:png,info}=await sharp(data,{limitInputPixels:24_000_000}).rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).png().toBuffer({resolveWithObject:true});
      const scale=Math.min(1,Math.min(620,width/15)/info.width,350/info.height);
      children.push(new Paragraph({alignment:AlignmentType.CENTER,keepNext:!!block.text,spacing:{before:100,after:80},children:[new ImageRun({type:"png",data:png,transformation:{width:Math.round(info.width*scale),height:Math.round(info.height*scale)},altText:{title:block.alt,description:block.alt,name:`Figure ${index+1}`}})]}));
      children.push(block.text?caption(block.text):gap());continue;
    }
    const heading = block.type === "heading", bullet = block.type === "bullet", isRtl = rtl(block.text);
    // Separate lines explicitly: Word does not interpret embedded newlines as line breaks.
    const lines = block.text.split(/\r?\n/);
    children.push(new Paragraph({
      heading: heading ? HeadingLevel.HEADING_1 : undefined,
      bidirectional: isRtl, alignment: isRtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
      numbering: bullet ? { reference: isRtl ? "report-rtl" : "report-ltr", level: 0 } : undefined,
      indent: bullet ? (isRtl ? { right: 360, hanging: 180 } : { left: 360, hanging: 180 }) : undefined,
      spacing: { before: heading ? 220 : 0, after: heading ? 120 : bullet ? 80 : 140, line: 320 },
      // Keep a section's introduction and first list item with enough context.
      keepNext: heading || (block.type === "paragraph" && blocks[index - 1]?.type === "heading") ||
        (bullet && blocks[index - 1]?.type === "paragraph" && blocks[index - 2]?.type === "heading"),
      widowControl: true,
      shading: heading ? { fill: "EAF5F5" } : undefined,
      border: heading ? { bottom: { style: BorderStyle.SINGLE, color: "C7E5E6", size: 4, space: 8 } } : undefined,
      children: lines.flatMap((line, index) => [
        ...(index ? [new TextRun({ break: 1 })] : []),
        run(line, heading ? 30 : 24, heading || !!block.bold, !!block.italic, heading ? accent : ink),
      ]),
    }));
  }
  return new Document({
    creator: "Loam", title: artifact.title,
    styles: { default: { document: { run: { font: "Arial", size: 24, sizeComplexScript: 24, color: ink }, paragraph: { spacing: { line: 320, after: 140 } } } } },
    numbering: { config: [false, true].map(isRtl => ({ reference: isRtl ? "report-rtl" : "report-ltr", levels: [{
      level: 0, format: LevelFormat.BULLET, text: "•", alignment: isRtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
      style: { run: { font: "Arial", color: accent }, paragraph: { indent: isRtl ? { right: 360, hanging: 180 } : { left: 360, hanging: 180 } } },
    }] })) },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134, header: 567, footer: 567 } } },
      headers: { default: new Header({ children: [new Paragraph({
        alignment: documentRtl ? AlignmentType.RIGHT : AlignmentType.LEFT, bidirectional: documentRtl,
        border: { bottom: { style: BorderStyle.SINGLE, color: "DCE5EB", size: 4, space: 8 } },
        children: [run(artifact.title, 18, false, false, muted)],
      })] }) },
      footers: { default: new Footer({ children: [new Paragraph({
        alignment: AlignmentType.CENTER, bidirectional: documentRtl,
        children: [run(documentRtl ? "صفحة " : "Page ", 18, false, false, muted),
          new TextRun({ children: [PageNumber.CURRENT], size: 18, sizeComplexScript: 18, color: muted }),
          run(documentRtl ? " من " : " of ", 18, false, false, muted),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, sizeComplexScript: 18, color: muted })],
      })] }) },
      children,
    }],
  });
}
