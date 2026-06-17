import YAML from "yaml";

export type FrontmatterValue = string | number | boolean | string[] | Record<string, unknown> | null;
export type Frontmatter = { raw: string; data: Record<string, FrontmatterValue>; bodyStart: number; bodyEnd: number };

export function parseFrontmatter(markdown: string): Frontmatter {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    return { raw: "", data: {}, bodyStart: 0, bodyEnd: 0 };
  }
  const marker = markdown.startsWith("---\r\n") ? "\r\n---\r\n" : "\n---\n";
  const end = markdown.indexOf(marker, 3);
  if (end < 0) return { raw: "", data: {}, bodyStart: 0, bodyEnd: 0 };
  const raw = markdown.slice(0, end + marker.length);
  const body = markdown.slice(markdown.startsWith("---\r\n") ? 5 : 4, end);
  return { raw, data: parseYamlFrontmatter(body), bodyStart: raw.length, bodyEnd: end + marker.length };
}

export function replaceFrontmatter(markdown: string, data: Record<string, FrontmatterValue>): string {
  const parsed = parseFrontmatter(markdown);
  const yaml = `---\n${YAML.stringify(data)}---\n`;
  return parsed.raw ? yaml + markdown.slice(parsed.bodyStart) : yaml + markdown;
}

export function frontmatterTags(data: Record<string, FrontmatterValue>): string[] {
  const value = data.tags ?? data.tag;
  if (Array.isArray(value)) return value.map(normalizeTag).filter(Boolean);
  if (typeof value === "string") return value.split(/[,\s]+/).map(normalizeTag).filter(Boolean);
  return [];
}

export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#/, "");
}

function parseYamlFrontmatter(body: string): Record<string, FrontmatterValue> {
  const parsed = YAML.parse(body) as unknown;
  if (!isRecord(parsed)) return {};
  return parsed as Record<string, FrontmatterValue>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
