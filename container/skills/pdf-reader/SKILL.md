# PDF Reader

Extracts text from PDF files. Available as `pdf-reader` in any Bash command.

## Usage

### Read a local PDF file

```bash
pdf-reader /workspace/group/attachments/document.pdf
```

### Fetch and read a PDF from a URL

```bash
pdf-reader fetch https://example.com/document.pdf
```

## Notes

- Telegram PDFs are automatically saved to `attachments/` when sent in the chat
- Only text-based PDFs work — scanned (image-only) PDFs return empty output
- For scanned PDFs, use agent-browser to view them visually instead
