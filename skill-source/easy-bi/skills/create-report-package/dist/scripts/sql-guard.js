// Shared SQL-safety primitives used by BOTH the package CLI (generation-time
// validation, report-package-cli.ts) and the shared Runtime (execution-time
// defense-in-depth, runtime-core.ts). These are pure predicates only — each
// caller raises its own error type/message and adds any caller-specific checks
// (the CLI resolves references against known columns; the Runtime adds a stricter
// UNION/second-SELECT ban on EXISTS skeletons). Keeping the regexes here stops the
// two guards from drifting apart.
/**
 * Characters allowed inside a trusted field expression, given the dialect's
 * identifier quote char. The OTHER quote char and single quotes stay banned so a
 * string literal can never appear.
 */
export function sqlExpressionAllowed(quoteChar) {
    return new RegExp(`^[A-Za-z0-9_${quoteChar}.,()\\s+\\-*/%]+$`);
}
/** Injection vectors / DML-DDL keywords banned inside a field expression. */
export function sqlExpressionDangerous(quoteChar) {
    const otherQuote = quoteChar === "`" ? '"' : "`";
    return new RegExp(`;|--|/\\*|\\*/|['${otherQuote}]|\\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|CALL|LOAD|OUTFILE)\\b`, "i");
}
/**
 * True when a field expression contains a disallowed character or a banned
 * keyword for the given dialect quote char. Reference resolution is the caller's
 * job (only the CLI has the known-column map).
 */
export function hasUnsafeSqlExpression(expression, quoteChar) {
    return (!sqlExpressionAllowed(quoteChar).test(expression) ||
        sqlExpressionDangerous(quoteChar).test(expression));
}
/**
 * The trusted EXISTS-subquery skeleton (built at generation time from knowledge,
 * never from user input) must be a correlated
 * `EXISTS (SELECT 1 FROM … WHERE … AND ` prefix plus a lone `)` suffix.
 */
export function isValidExistsSkeleton(prefix, suffix) {
    return /^EXISTS \(SELECT 1 FROM .+ WHERE .+ AND $/.test(prefix) && suffix === ")";
}
/** Injection vectors banned in the EXISTS skeleton prefix. */
export function hasSkeletonInjection(prefix) {
    return /;|--|\/\*|\*\/|'/.test(prefix);
}
/**
 * The comparison operators a boolean-flag field may use to fold a numeric/status
 * column into a 是/否 truth value (e.g. `receipt_count > 0`). The value is the SQL
 * symbol emitted; the KEY is the only thing a plan/config may name — a free-form
 * operator string can never reach SQL, so no injection vector exists here. Shared
 * by the generation-time builder (report-package-cli.ts) and the execution-time
 * predicate (runtime-core.ts) so the two agree on the exact allowed set.
 */
export const FLAG_OPERATOR_SYMBOLS = {
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
    eq: "=",
    ne: "<>",
};
/**
 * True when `expr` is a single bare dialect-quoted `alias.col` reference and
 * nothing else (e.g. `` t0.`receipt_count` ``) — the shape a boolean-flag truth
 * expression must have. Comparison operators and the threshold literal are NOT in
 * the expression; they are applied structurally by the builder/predicate from the
 * validated operator key + a `Number()`-coerced threshold, so the column reference
 * is the only free text and it is fully constrained here.
 */
export function isBareQuotedColumnRef(expr, quoteChar) {
    return new RegExp(`^[A-Za-z][A-Za-z0-9_]*\\.${quoteChar}[A-Za-z0-9_$]+${quoteChar}$`).test(String(expr ?? "").trim());
}
//# sourceMappingURL=sql-guard.js.map