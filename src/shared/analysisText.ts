/**
 * Runtime-distinguishable text kinds for NLP analysis (task 21.1; R8.6; design:
 * NLP port and FilingRiskScore).
 *
 * `FilingText` (SEC filing text) and `SentimentText` (market sentiment text) are
 * separate classes with private fields. TypeScript treats them as nominal, so one
 * is never assignable to the other, and at run time `instanceof` tells them apart,
 * so the filing analyzer and the sentiment pipeline can each refuse the other's
 * text. Instances are frozen; the text is held unchanged.
 */

export class FilingText {
  readonly #text: string;

  private constructor(text: string) {
    this.#text = text;
    Object.freeze(this);
  }

  /** Wraps SEC filing text. Throws `TypeError` for a non-string. */
  static of(text: string): FilingText {
    if (typeof text !== 'string') {
      throw new TypeError('FilingText.of requires a string.');
    }
    return new FilingText(text);
  }

  get text(): string {
    return this.#text;
  }
}

export class SentimentText {
  readonly #text: string;

  private constructor(text: string) {
    this.#text = text;
    Object.freeze(this);
  }

  /** Wraps market sentiment text. Throws `TypeError` for a non-string. */
  static of(text: string): SentimentText {
    if (typeof text !== 'string') {
      throw new TypeError('SentimentText.of requires a string.');
    }
    return new SentimentText(text);
  }

  get text(): string {
    return this.#text;
  }
}
