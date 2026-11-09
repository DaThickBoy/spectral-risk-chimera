/**
 * FIX mapping table interface (task 18.1; design: FIX Parser; U-4, OD-9 open).
 *
 * The accepted BeginString values, message types, and trade-signalling
 * `ExecType` (150) values differ between FIX 4.2 and FIX 4.4 and are decided
 * from real sample logs (OD-9). Until then the table is empty: no message is
 * mapped to a transaction, and nothing in 18.1 reads it. Filling it in and
 * mapping fields (17, 55, 54, 32, 31, 15, 60) is task 18.2.
 */
export interface FixMappingTable {
  readonly beginStrings: readonly string[];
  readonly msgTypes: readonly string[];
  readonly execTypes: readonly string[];
}

/** Deliberately empty while OD-9 is open. */
export const FIX_MAPPING_TABLE: FixMappingTable = Object.freeze({
  beginStrings: Object.freeze([]),
  msgTypes: Object.freeze([]),
  execTypes: Object.freeze([]),
});
