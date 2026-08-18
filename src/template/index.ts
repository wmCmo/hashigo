/**
 * Stage 3 — the template engine.
 *
 * Two syntax surfaces, one parser, one AST, and a resolver that turns a template
 * plus a card's field values into the ordered sides SPEC's data model asks for.
 * Stops at the AST: the renderer is stage 4.
 *
 *   ast.ts      node types, the element allowlist / sanitiser policy, walkers,
 *               and the census the acceptance tests count with
 *   parse.ts    `parseTemplate` (surface 2) and `parseContent` (surface 1),
 *               plus the `<<Field>>` lexer both share
 *   resolve.ts  sections, interpolation, sides, and the reverse permutation
 *
 * Read the header of each for the measured reasoning; `test/template.test.ts`
 * re-derives every figure quoted in them from the real exports.
 */

export * from "./ast.js";
export * from "./parse.js";
export * from "./resolve.js";
