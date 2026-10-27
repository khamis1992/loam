export interface ReviewParagraph {
  index: number;
  start: number;
  end: number;
  quote: string;
}

export function reviewParagraphs(text: string): ReviewParagraph[] {
  const paragraphs: ReviewParagraph[] = [];
  const pattern = /[^\r\n]+(?:\r?\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[0];
    const quote = raw.trimEnd();
    if (quote.trim()) paragraphs.push({ index: paragraphs.length, start: match.index, end: match.index + quote.length, quote });
  }
  return paragraphs;
}
