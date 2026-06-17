import { getDocumentMap as getMarkdownPatchDocumentMap } from "markdown-patch";
import { frontmatterTags, parseFrontmatter } from "./frontmatter.js";

export type Heading = { path: string; text: string; level: number; line: number; start: number; contentStart: number; end: number };
export type Block = { id: string; line: number; start: number; end: number };
export type DocumentMap = {
  headings: string[];
  headingDetails: Heading[];
  blocks: string[];
  blockDetails: Block[];
  frontmatterFields: string[];
  links: string[];
  embeds: string[];
  tags: string[];
};

export function getDocumentMap(markdown: string): DocumentMap {
  const frontmatter = parseFrontmatter(markdown);
  const patchMap = getMarkdownPatchDocumentMap(markdown);
  const headings: Heading[] = Object.entries(patchMap.heading).map(([key, value]) => {
    const path = key.split("\x1f").filter(Boolean).join("::");
    const parts = path.split("::");
    return {
      path,
      text: parts.at(-1) ?? path,
      level: value.level,
      line: lineNumberAt(markdown, value.marker.start),
      start: value.marker.start,
      contentStart: value.content.start,
      end: value.content.end
    };
  });
  const blocks: Block[] = Object.entries(patchMap.block).map(([id, value]) => ({
    id,
    line: lineNumberAt(markdown, value.marker.start),
    start: Math.min(value.content.start, value.marker.start),
    end: Math.max(value.content.end, value.marker.end)
  }));
  const links = new Set<string>();
  const embeds = new Set<string>();
  const tags = new Set<string>(frontmatterTags(frontmatter.data));
  let inFence = false;

  for (const record of lineOffsets(markdown)) {
    const line = record.text.replace(/\r?\n$/, "");
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    for (const match of line.matchAll(/(!?)\[\[([^\]]+)\]\]/g)) {
      const target = match[2]?.trim();
      if (!target) continue;
      if (match[1] === "!") embeds.add(target);
      else links.add(target);
    }
    for (const match of line.matchAll(/(?:^|[\s([{])#([\p{L}\p{N}_/-]+)/gu)) {
      if (match[1]) tags.add(match[1]);
    }
  }

  return {
    headings: headings.map((heading) => heading.path),
    headingDetails: headings,
    blocks: [...new Set(blocks.map((block) => block.id))],
    blockDetails: blocks,
    frontmatterFields: Object.keys(frontmatter.data),
    links: [...links].sort(),
    embeds: [...embeds].sort(),
    tags: [...tags].filter(Boolean).sort()
  };
}

export function lineOffsets(markdown: string): Array<{ text: string; start: number; end: number }> {
  const records: Array<{ text: string; start: number; end: number }> = [];
  const regex = /[^\n]*\n|[^\n]+$/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    const text = match[0];
    records.push({ text, start: match.index, end: match.index + text.length });
  }
  if (records.length === 0) records.push({ text: "", start: 0, end: 0 });
  return records;
}

function lineNumberAt(markdown: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < markdown.length; index += 1) {
    if (markdown[index] === "\n") line += 1;
  }
  return line;
}
