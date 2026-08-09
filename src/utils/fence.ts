/**
 * Fenced-code helpers shared by every extractor that emits a code block.
 *
 * A fixed three-backtick fence breaks whenever the content itself contains a
 * three-backtick run — a Markdown tutorial inside a `<pre>`, or a PDF table
 * fallback that happens to include one. The fence length is therefore always
 * computed from the content.
 */

const MIN_FENCE = 3;

/** The longest run of consecutive backticks anywhere in `code`. */
function longestBacktickRun(code: string): number {
  let longest = 0;
  let run = 0;
  for (const ch of code) {
    run = ch === '`' ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

/** A fence guaranteed to be longer than any backtick run inside `code`. */
export function fenceDelimiter(code: string): string {
  return '`'.repeat(Math.max(MIN_FENCE, longestBacktickRun(code) + 1));
}

/**
 * Wrap `code` in a fence that cannot be closed early by its own content.
 * `lang` is emitted as the info string when the source supplied one — a single
 * token that materially helps a model read the block.
 */
export function fencedBlock(code: string, lang?: string): string {
  const body = code.replace(/\n+$/, '');
  const fence = fenceDelimiter(body);
  return `${fence}${lang ?? ''}\n${body}\n${fence}`;
}
