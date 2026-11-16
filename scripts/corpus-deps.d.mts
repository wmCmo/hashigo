export declare const CORPUS_TESTS: readonly string[];
export declare function corpusReach(root: string): Set<string>;
export declare function changedFiles(root: string): string[];
export declare function corpusTouched(root: string, changed?: readonly string[]): string[];
