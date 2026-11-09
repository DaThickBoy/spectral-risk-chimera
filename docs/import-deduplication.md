# How CSV imports detect duplicates

This page explains how Spectral Risk Chimera decides that an imported row is a duplicate. It also covers one limitation you should know about (requirement R28.14, interim position for open decision OD-8).

## Transaction keys

Every accepted row gets a transaction key. A row is a duplicate when a transaction with the same key already exists in the portfolio, or when an earlier accepted row in the same file has that key. A duplicate creates no transaction and is counted under `duplicates` in the import summary.

- **Rows with `external_id`.** The key comes from the portfolio, the import's source label, and the `external_id`. The other fields do not count. A second row with the same `external_id` and source label is a duplicate, in the same file or in a later file, even if its quantity or price differs.
- **Rows without `external_id`.** The key comes from the portfolio, the trade timestamp (converted to UTC), ticker, type, quantity, price, currency, and an occurrence number. If a file contains identical rows, they get occurrence 1, 2, and so on, and all of them are imported (R28.14).
- A row rejected by validation (for example `OVERSELL` or `CURRENCY_MISMATCH`) creates no transaction, so later rows never count as its duplicates.

## Importing the same file again

Importing the same file again creates no new transactions. Every row that is not rejected is reported as a duplicate (R28.13). To fix rejected rows, correct them and import the corrected file. The rows you did not change are duplicates, and only the corrected rows are added.

## Limitation: identical trades without `external_id` in different files

Occurrence numbers restart for each file. Suppose a trade without `external_id` appears in one file, and an identical trade (same timestamp, ticker, type, quantity, price, and currency) appears in a different file. The second one gets the same key and is treated as a duplicate, even if it was a separate real trade.

To avoid this:

- Include an `external_id` column with the broker's unique trade or execution identifier. This is the recommended option.
- Otherwise, import all trades of one period in a single file, so identical trades get different occurrence numbers.

Check the `duplicates` count in each import summary. If it is higher than you expect, compare the file with what is already in the portfolio before you import again.
