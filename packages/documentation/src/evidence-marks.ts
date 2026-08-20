// packages/documentation/src/evidence-marks.ts
//
// `business.md`, `technical.md`, and `operations.md` are one deliverable
// read by the same audience across three files, so they cite evidence one
// way: a short, stable `[eN]` mark inline in the body, resolved back to its
// full `sha256:<64hex>` id in a table at the end of the document. A full
// 64-character hash inline in reader-facing prose or a 47-row table would
// hurt readability more than it would help traceability — but every id this
// class emits is a real evidence id straight from the snapshot, so each
// document's "every claim cites evidence that exists" guarantee still
// holds.
//
// This was previously three private classes — one in `business.ts`, one
// copied verbatim into `technical.ts`, and no equivalent at all in
// `operations.ts`, which printed raw hashes inline instead. Two verbatim
// copies are two copies free to drift, which is exactly how the citation
// notation diverged in the first place. There is now exactly one
// `EvidenceRegistry`, shared by all three renderers.

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Assigns each cited evidence id a short, stable footnote mark in the order
 * it is first cited, and renders the mapping back to full ids at the end of
 * the document.
 */
export class EvidenceRegistry {
  private readonly order: string[] = [];
  private readonly marks = new Map<string, number>();

  cite(evidenceIds: readonly string[]): string {
    const sorted = [...new Set(evidenceIds)].sort(compareStrings);
    const marks: string[] = [];
    for (const id of sorted) {
      let mark = this.marks.get(id);
      if (mark === undefined) {
        mark = this.order.length + 1;
        this.marks.set(id, mark);
        this.order.push(id);
      }
      marks.push(`[e${String(mark)}]`);
    }
    return marks.join('');
  }

  entries(): readonly { readonly mark: string; readonly evidenceId: string }[] {
    return this.order.map((evidenceId, index) => ({
      mark: `[e${String(index + 1)}]`,
      evidenceId,
    }));
  }
}
