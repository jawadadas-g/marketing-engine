/** What a registrar can tell us about a company, given its CR number. */
export type CompanyFacts = {
  name: string;
  nameEn?: string | undefined;
  status?: string | undefined;
  city?: string | undefined;
  activities?: string[] | undefined;
  /** The provider's response as received, kept on the source row. */
  raw: unknown;
};

export interface CompanyLookup {
  readonly provider: string;
  byCr(cr: string): Promise<CompanyFacts | null>;
}
