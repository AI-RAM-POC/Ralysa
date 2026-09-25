// The token contract's version markers (F-002 design §3.10, [AR-18]): claims evolve additively;
// verifiers ignore unknown claims and reject any other `alg` or `typ`.
export const ACCESS_TOKEN_TYP = 'at+jwt' as const;
export const ACCESS_TOKEN_ALG = 'ES256' as const;
