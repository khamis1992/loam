/** One literal path argument for bash. JSON quoting does not escape $() or backticks. */
export function bashPath(value: string): string {
  if (value.includes("\0")) throw new Error("NUL is not allowed in a path");
  const literal = value.startsWith("-") ? `./${value}` : value;
  return '"' + literal.replace(/[\\"$`]/g, character => "\\" + character) + '"';
}
