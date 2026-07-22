/**
 * Characters allowed inside a trusted field expression, given the dialect's
 * identifier quote char. The OTHER quote char and single quotes stay banned so a
 * string literal can never appear.
 */
export declare function sqlExpressionAllowed(quoteChar: string): RegExp;
/** Injection vectors / DML-DDL keywords banned inside a field expression. */
export declare function sqlExpressionDangerous(quoteChar: string): RegExp;
/**
 * True when a field expression contains a disallowed character or a banned
 * keyword for the given dialect quote char. Reference resolution is the caller's
 * job (only the CLI has the known-column map).
 */
export declare function hasUnsafeSqlExpression(expression: string, quoteChar: string): boolean;
/**
 * The trusted EXISTS-subquery skeleton (built at generation time from knowledge,
 * never from user input) must be a correlated
 * `EXISTS (SELECT 1 FROM … WHERE … AND ` prefix plus a lone `)` suffix.
 */
export declare function isValidExistsSkeleton(prefix: string, suffix: string): boolean;
/** Injection vectors banned in the EXISTS skeleton prefix. */
export declare function hasSkeletonInjection(prefix: string): boolean;
/**
 * The comparison operators a boolean-flag field may use to fold a numeric/status
 * column into a 是/否 truth value (e.g. `receipt_count > 0`). The value is the SQL
 * symbol emitted; the KEY is the only thing a plan/config may name — a free-form
 * operator string can never reach SQL, so no injection vector exists here. Shared
 * by the generation-time builder (report-package-cli.ts) and the execution-time
 * predicate (runtime-core.ts) so the two agree on the exact allowed set.
 */
export declare const FLAG_OPERATOR_SYMBOLS: Record<string, string>;
/**
 * True when `expr` is a single bare dialect-quoted `alias.col` reference and
 * nothing else (e.g. `` t0.`receipt_count` ``) — the shape a boolean-flag truth
 * expression must have. Comparison operators and the threshold literal are NOT in
 * the expression; they are applied structurally by the builder/predicate from the
 * validated operator key + a `Number()`-coerced threshold, so the column reference
 * is the only free text and it is fully constrained here.
 */
export declare function isBareQuotedColumnRef(expr: string, quoteChar: string): boolean;
