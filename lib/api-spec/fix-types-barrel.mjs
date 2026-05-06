/**
 * Post-codegen fix: removes type-barrel re-exports whose names clash with
 * a Zod schema const in api.ts to prevent TS2308 ambiguity in the barrel.
 * The TypeScript type can always be derived via `zod.infer<typeof Schema>`.
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const apiZodSrc = resolve(__dir, "..", "api-zod", "src", "generated");
const typesIndex = resolve(apiZodSrc, "types", "index.ts");
const apiTs = resolve(apiZodSrc, "api.ts");

const apiContent = readFileSync(apiTs, "utf8");
const typesContent = readFileSync(typesIndex, "utf8");

// Collect all Zod schema const names exported from api.ts
const constNames = new Set(
  [...apiContent.matchAll(/^export const (\w+)/gm)].map((m) => m[1]),
);

// Derive the PascalCase export name from a barrel path like "./importBudgetPositionsBody"
function toPascalName(modulePath) {
  return modulePath
    .replace(/^\.\//, "")
    .split(/[-/]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

// Remove re-export lines whose exported name clashes with a Zod const.
const fixed = typesContent.replace(
  /^export (?:type \* |type \* |\* )from "(\.\/[^"]+)";$/gm,
  (line, modulePath) => {
    const pascalName = toPascalName(modulePath);
    if (constNames.has(pascalName)) {
      // Comment out the conflicting line — Zod schema in api.ts is the
      // canonical export; TS type can be derived with zod.infer<typeof Name>.
      return `// [barrel-fix] removed conflicting type re-export: ${line}`;
    }
    return line;
  },
);

writeFileSync(typesIndex, fixed, "utf8");
console.log("fix-types-barrel: patched", typesIndex);
