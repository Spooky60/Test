# Expense Tracker

A browser-only expense tracker for credit card statements. Statement files are
parsed locally (SheetJS for spreadsheets, pdf.js for PDFs) and saved in the
browser's localStorage — nothing is sent to a server.

## Run

    npm install && npm start      # then open http://localhost:3000/expenses/

Or just open `public/expenses/index.html` with any static file server.

## Features

- **Import** PDF, XLSX, XLS or CSV statements (drag & drop, several at once).
  Header rows are detected automatically in English and Hebrew (Isracard / Max /
  Cal style exports, and Chase / Amex / generic CSVs), including files with
  several tables per sheet. Re-importing a file does not create duplicates.
- **Categorize** with ~20 built-in categories (English + Hebrew merchant
  keywords). Changing a transaction's category saves a rule for that merchant
  and re-applies it everywhere; rules can be managed in the *Rules* tab.
- **Group with context**: category → merchant → transactions, with share of
  spending, average, month-over-month change, and tags for recurring charges,
  installment plans (`תשלום 2 מתוך 6`), foreign-currency purchases and refunds.
- **Overview**: monthly trend, “what stands out” insights, recurring
  subscriptions and bills, remaining installment balances, top merchants and
  largest purchases. Filter by month and by card; export to CSV.

## Limits

- PDF parsing reads text lines that contain a date and an amount. Scanned
  (image-only) PDFs need OCR first, and unusual layouts may need the XLSX/CSV
  export instead, which is always more reliable.
- Totals assume one billing currency (set in the header).
