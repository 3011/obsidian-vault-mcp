import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FsVault } from "../src/vault/FsVault.js";

const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-vault-mcp-asset-audit-"));
const vaultRoot = path.join(root, "vault");

try {
  await mkdir(path.join(vaultRoot, "Assets", "nested"), { recursive: true });
  await mkdir(path.join(vaultRoot, "Notes", "sub"), { recursive: true });
  await mkdir(path.join(vaultRoot, "Notes", "assets"), { recursive: true });
  await mkdir(path.join(vaultRoot, "Other", "assets"), { recursive: true });

  await writeBinary("Assets/exact.png", 0x01);
  await writeBinary("Assets/unique.png", 0x02);
  await writeBinary("Assets/my image.png", 0x03);
  await writeBinary("Assets/截图 2026.png", 0x04);
  await writeBinary("Assets/ambig.png", 0x05);
  await writeBinary("Other/assets/ambig.png", 0x06);
  await writeBinary("Assets/Case.PNG", 0x07);
  await writeBinary("Assets/orphan.png", 0x08);
  await writeBinary("Assets/nested/deep.png", 0x09);
  await writeBinary("Notes/assets/rel.png", 0x0a);
  await writeBinary("Assets/custom.png", 0x0b);
  await writeFile(path.join(vaultRoot, "Assets", "readme.txt"), "asset text\n", "utf8");

  await writeFile(path.join(vaultRoot, "Notes", "references.md"), `# References

![[Assets/exact.png]]
![[unique.png#heading|Alias]]
![encoded](../Assets/my%20image.png "title")
<img src='../Assets/截图%202026.png'>
<img src=../Assets/exact.png>
![[ambig.png]]
![[case.png]]
![[missing.png]]
<custom-image src="../Assets/custom.png"></custom-image>

\`\`\`md
![[orphan.png]]
\`\`\`

Inline code \`![[orphan.png]]\` should not count.
Plain text mentions orphan.png but is not a reference.
`, "utf8");
  await writeFile(path.join(vaultRoot, "Notes", "sub", "relative.md"), "![relative](../assets/rel.png)\n", "utf8");

  const vault = new FsVault(vaultRoot, "98-Inbox");
  await vault.init();

  await testDetailedListing(vault);
  await testReferenceResolution(vault);
  await testAuditComposition(vault);
  console.log("asset audit ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function testDetailedListing(vault: FsVault): Promise<void> {
  const shallow = await vault.listDetailed({ path: "Assets", recursive: false }) as any;
  assert.equal(shallow.exists, true);
  assert.equal(shallow.kind, "directory");
  assert.equal(shallow.isEmpty, false);
  assert(shallow.entries.some((entry: any) => entry.path === "Assets/nested" && entry.kind === "directory"));
  assert(!shallow.entries.some((entry: any) => entry.path === "Assets/nested/deep.png"));
  assert(shallow.entries.some((entry: any) => entry.path === "Assets/readme.txt" && entry.isAttachment === true));

  const recursive = await vault.listDetailed({ path: "Assets", recursive: true, includeSha256: true }) as any;
  const deep = recursive.entries.find((entry: any) => entry.path === "Assets/nested/deep.png");
  assert(deep);
  assert.equal(deep.mime, "image/png");
  assert.equal(typeof deep.sha256, "string");

  const file = await vault.listDetailed({ path: "Assets/exact.png" }) as any;
  assert.equal(file.exists, true);
  assert.equal(file.kind, "file");
  assert.equal(file.entries[0].path, "Assets/exact.png");

  const missing = await vault.listDetailed({ path: "Assets/missing" }) as any;
  assert.equal(missing.exists, false);
  assert.equal(missing.kind, "missing");

  const denied = await vault.listDetailed({ path: ".obsidian" }) as any;
  assert.equal(denied.exists, null);
  assert.equal(denied.kind, "denied");
}

async function testReferenceResolution(vault: FsVault): Promise<void> {
  const refs = await vault.findAssetReferences({
    assetPaths: [
      "Assets/exact.png",
      "Notes/assets/rel.png",
      "Assets/unique.png",
      "Assets/my image.png",
      "Assets/截图 2026.png",
      "Assets/ambig.png",
      "Other/assets/ambig.png",
      "Assets/Case.PNG",
      "Assets/custom.png",
      "Assets/orphan.png",
      "Assets/missing.png"
    ]
  }) as any;

  assert.equal(refs.scanCompleteness, "full_vault");
  assert.equal(refs.parserCoverage.note.includes("may not detect custom plugin references"), true);

  const exact = result(refs, "Assets/exact.png");
  assert.equal(exact.trashSafety, "unsafe");
  assert(exact.references.some((reference: any) => reference.resolution === "exact_path"));
  assert(exact.references.some((reference: any) => reference.referenceType === "html_img"));

  const relative = result(refs, "Notes/assets/rel.png");
  assert.equal(relative.trashSafety, "unsafe");
  assert(relative.references.some((reference: any) => reference.resolution === "relative_path"));

  const unique = result(refs, "Assets/unique.png");
  assert.equal(unique.trashSafety, "unsafe");
  assert(unique.references.some((reference: any) => reference.resolution === "basename_unique"));
  assert(unique.references.some((reference: any) => reference.raw === "![[unique.png#heading|Alias]]"));

  const spaced = result(refs, "Assets/my image.png");
  assert.equal(spaced.trashSafety, "unsafe");
  assert(spaced.references.some((reference: any) => reference.referenceType === "markdown_image"));

  const chinese = result(refs, "Assets/截图 2026.png");
  assert.equal(chinese.trashSafety, "unsafe");
  assert(chinese.references.some((reference: any) => reference.referenceType === "html_img"));

  const ambigA = result(refs, "Assets/ambig.png");
  const ambigB = result(refs, "Other/assets/ambig.png");
  assert.equal(ambigA.ambiguous, true);
  assert.equal(ambigA.trashSafety, "unknown");
  assert.equal(ambigA.trashSafetyReason, "ambiguous_basename_reference");
  assert.equal(ambigB.ambiguous, true);
  assert.equal(ambigB.trashSafety, "unknown");

  const caseMismatch = result(refs, "Assets/Case.PNG");
  assert.equal(caseMismatch.trashSafety, "unknown");
  assert.equal(caseMismatch.trashSafetyReason, "unresolved_reference_may_match_asset");
  assert(caseMismatch.unresolvedPotentialMatches > 0);
  assert(caseMismatch.references.some((reference: any) => reference.resolution === "unresolved"));

  const custom = result(refs, "Assets/custom.png");
  assert.equal(custom.referencedByCount, 0);
  assert.equal(custom.unsupportedPotentialMatches, 1);
  assert.equal(custom.trashSafety, "unknown");
  assert.equal(custom.trashSafetyReason, "unsupported_potential_reference");
  assert.equal(custom.warnings[0].warningType, "unsupported_potential_match");

  const orphan = result(refs, "Assets/orphan.png");
  assert.equal(orphan.candidateOrphan, true);
  assert.equal(orphan.referencedByCount, 0);
  assert.equal(orphan.references.length, 0);
  assert.equal(orphan.trashSafety, "safe");

  const missing = result(refs, "Assets/missing.png");
  assert.equal(missing.exists, false);
  assert.equal(missing.unresolvedPotentialMatches, 1);
  assert.equal(missing.warnings[0].warningType, "unresolved_potential_match");
  assert.equal(missing.trashSafety, "unknown");
  assert.equal(missing.trashSafetyReason, "asset_path_does_not_exist");

  const scoped = await vault.findAssetReferences({ assetPaths: ["Assets/orphan.png"], scope: "Notes" }) as any;
  const scopedOrphan = result(scoped, "Assets/orphan.png");
  assert.equal(scoped.scanCompleteness, "scoped");
  assert.equal(scopedOrphan.candidateOrphan, true);
  assert.equal(scopedOrphan.trashSafety, "unknown");
  assert.equal(scopedOrphan.trashSafetyReason, "scan_is_not_full_vault");
  assert.equal(scoped.warnings.length, 0);

  const fileScoped = await vault.findAssetReferences({ assetPaths: ["Assets/exact.png"], scope: "Notes/references.md" }) as any;
  const fileScopedExact = result(fileScoped, "Assets/exact.png");
  assert.equal(fileScoped.scanCompleteness, "scoped");
  assert.equal(fileScoped.scanScope, "Notes/references.md");
  assert.equal(fileScoped.warnings.length, 0);
  assert.equal(fileScopedExact.trashSafety, "unsafe");
  assert(fileScopedExact.references.some((reference: any) => reference.resolution === "exact_path"));
}

async function testAuditComposition(vault: FsVault): Promise<void> {
  const audit = await vault.assetAudit({ root: "Assets", recursive: true }) as any;
  assert.equal(audit.rootExists, true);
  assert.equal(audit.rootKind, "directory");
  assert.equal(audit.scanCompleteness, "full_vault");
  assert(audit.summary.totalAssets >= 8);
  assert(audit.summary.safeToTrash >= 2);
  assert(audit.summary.unsafe >= 4);
  assert(audit.summary.unknown >= 2);

  const orphan = audit.assets.find((entry: any) => entry.path === "Assets/orphan.png");
  assert.equal(orphan.trashSafety, "safe");
  const ambiguous = audit.assets.find((entry: any) => entry.path === "Assets/ambig.png");
  assert.equal(ambiguous.trashSafety, "unknown");
  const caseMismatch = audit.assets.find((entry: any) => entry.path === "Assets/Case.PNG");
  assert.equal(caseMismatch.trashSafety, "unknown");

  const scopedAudit = await vault.assetAudit({ root: "Assets", scope: "Notes" }) as any;
  assert.equal(scopedAudit.scanCompleteness, "scoped");
  assert.equal(scopedAudit.assets.find((entry: any) => entry.path === "Assets/orphan.png").trashSafety, "unknown");

  const missingRoot = await vault.assetAudit({ root: "MissingAssets" }) as any;
  assert.equal(missingRoot.rootExists, false);
  assert.equal(missingRoot.rootKind, "missing");
  assert.equal(missingRoot.summary.totalAssets, 0);
}

async function writeBinary(relative: string, marker: number): Promise<void> {
  await writeFile(path.join(vaultRoot, ...relative.split("/")), Buffer.from([0x89, 0x50, 0x4e, 0x47, marker]));
}

function result(refs: any, assetPath: string): any {
  const found = refs.results.find((item: any) => item.assetPath === assetPath);
  assert(found, `missing result for ${assetPath}`);
  return found;
}
