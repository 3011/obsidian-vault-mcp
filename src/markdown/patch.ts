import { applyPatch, type PatchInstruction, ContentType } from "markdown-patch";

export type PatchArgs = {
  targetType: "heading" | "block" | "frontmatter";
  target: string;
  operation: "replace" | "prepend" | "append";
  content: unknown;
  contentType?: string;
  createTargetIfMissing?: boolean;
  trimTargetWhitespace?: boolean;
  rejectIfContentPreexists?: boolean;
  targetDelimiter?: string;
  targetScope?: "content" | "marker" | "markerAndContent";
};

export function patchMarkdown(markdown: string, args: PatchArgs): string {
  const delimiter = args.targetDelimiter || "::";
  const instruction: PatchInstruction = {
    targetType: args.targetType,
    target: args.targetType === "heading" ? args.target.split(delimiter) : args.target.replace(/^\^/, ""),
    operation: args.operation,
    content: args.contentType === ContentType.json ? args.content : String(args.content),
    contentType: args.contentType === ContentType.json ? ContentType.json : ContentType.text,
    createTargetIfMissing: args.createTargetIfMissing,
    trimTargetWhitespace: args.trimTargetWhitespace,
    rejectIfContentPreexists: args.rejectIfContentPreexists,
    targetScope: args.targetScope
  } as PatchInstruction;
  return applyPatch(markdown, instruction);
}
