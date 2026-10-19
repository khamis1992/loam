export interface Finding {
  line: number;
  column: number;
  text: string;
}

export function auditComponentSource(source: string, filePath?: string): Finding[];
