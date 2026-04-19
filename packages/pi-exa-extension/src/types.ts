export type ExaSearchType = "auto" | "neural" | "keyword";

export interface ExaExtensionConfig {
  apiKey: string | undefined;
  defaultSearchType: ExaSearchType;
  defaultNumResults: number;
  maxTextPerResult: number;
}
